use crate::{
    ConductorError, ConductorRuntime, ExecutionPayload, JsonFileStore, PersistenceError,
    ResolvedInvocation,
};
use phenix_backend::{
    Backend, BackendError, BackendEvent, BackendHost, BackendSession, ToolInvocation, ToolResult,
};
use phenix_core::{
    AuthenticationMethodId, BackendCatalog, BackendId, CallableId, ExecutionEventKind, ExecutionId,
    ExecutionState, ExecutionTarget, SessionId,
};
use phenix_protocol::{
    ClientMessage, Command, ErrorCode, ProtocolError, Reply, ResponsePayload, ServerMessage,
};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, BufRead, Write};
use std::sync::{
    mpsc::{self, Receiver, SyncSender},
    Arc, Mutex, MutexGuard,
};
use std::thread;

const EVENT_BUFFER: usize = 256;
const OUTPUT_BUFFER: usize = 256;
const EXECUTION_BUFFER: usize = 64;

type SharedBackend = Arc<Mutex<Box<dyn Backend>>>;
type SharedRuntime = Arc<Mutex<ConductorRuntime>>;
type ActiveScopes = Arc<Mutex<BTreeMap<ExecutionId, LiveExecutionScope>>>;

struct ExecutionJob {
    resolved: ResolvedInvocation,
    backend: SharedBackend,
}

/// Process-local resources owned by one live execution. Durable execution state
/// remains in `ConductorRuntime`; this scope is deliberately not persisted.
#[derive(Clone)]
struct LiveExecutionScope {
    backend_session: Arc<dyn BackendSession>,
}

/// RAII lease for one live execution scope. Once installed, every return path
/// from the worker tears the process-local scope down, including error returns
/// and unwinding. Durable execution state remains owned by `ConductorRuntime`.
struct LiveExecutionLease {
    scopes: ActiveScopes,
    execution_id: ExecutionId,
}

impl Drop for LiveExecutionLease {
    fn drop(&mut self) {
        if let Ok(mut scopes) = self.scopes.lock() {
            scopes.remove(&self.execution_id);
        }
    }
}

pub struct ConductorServer {
    runtime: SharedRuntime,
    backends: BTreeMap<BackendId, SharedBackend>,
    catalogs: BTreeMap<BackendId, BackendCatalog>,
    active_scopes: ActiveScopes,
    store: Option<JsonFileStore>,
    persist_lock: Arc<Mutex<()>>,
}

impl ConductorServer {
    #[must_use]
    pub fn new(runtime: ConductorRuntime) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(runtime)),
            backends: BTreeMap::new(),
            catalogs: BTreeMap::new(),
            active_scopes: Arc::new(Mutex::new(BTreeMap::new())),
            store: None,
            persist_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn load_or_new(store: JsonFileStore) -> Result<Self, ServerError> {
        let runtime = match store.load() {
            Ok(checkpoint) => ConductorRuntime::restore(checkpoint)?,
            Err(PersistenceError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                ConductorRuntime::new()
            }
            Err(error) => return Err(error.into()),
        };
        let mut server = Self::new(runtime);
        server.store = Some(store);
        {
            let mut runtime = server.lock_runtime()?;
            runtime.interrupt_non_resumable_executions()?;
        }
        server.persist()?;
        Ok(server)
    }

    pub fn register_backend(
        &mut self,
        backend_id: BackendId,
        backend: Box<dyn Backend>,
    ) -> Result<(), ServerError> {
        if self.backends.contains_key(&backend_id) {
            return Err(ServerError::DuplicateBackend(backend_id));
        }
        self.backends
            .insert(backend_id, Arc::new(Mutex::new(backend)));
        Ok(())
    }

    pub fn runtime(&self) -> MutexGuard<'_, ConductorRuntime> {
        self.runtime
            .lock()
            .expect("conductor runtime lock must not be poisoned")
    }

    #[must_use]
    pub fn catalogs(&self) -> Vec<BackendCatalog> {
        self.catalogs.values().cloned().collect()
    }

    pub fn serve_ndjson<R, W>(&mut self, input: R, output: W) -> Result<(), ServerError>
    where
        R: BufRead,
        W: Write + Send,
    {
        let event_receiver = {
            let mut runtime = self.lock_runtime()?;
            runtime.subscribe_events(EVENT_BUFFER)
        };
        let (output_sender, output_receiver) = mpsc::sync_channel(OUTPUT_BUFFER);
        let (execution_sender, execution_receiver) = mpsc::sync_channel(EXECUTION_BUFFER);

        let runtime = self.runtime.clone();
        let active_scopes = self.active_scopes.clone();
        let store = self.store.clone();
        let persist_lock = self.persist_lock.clone();

        thread::scope(|scope| {
            let writer = scope.spawn(move || -> Result<(), ServerError> {
                let mut output = output;
                while let Ok(message) = output_receiver.recv() {
                    serde_json::to_writer(&mut output, &message)?;
                    output.write_all(b"\n")?;
                    output.flush()?;
                }
                Ok(())
            });

            let event_output = output_sender.clone();
            let relay = scope.spawn(move || {
                while let Ok(event) = event_receiver.recv() {
                    if event_output.send(ServerMessage::Event { event }).is_err() {
                        break;
                    }
                }
            });

            let executor = scope.spawn(move || {
                execution_loop(
                    execution_receiver,
                    runtime,
                    active_scopes,
                    store,
                    persist_lock,
                )
            });

            let result = self.read_requests(input, &output_sender, &execution_sender);
            drop(execution_sender);
            let executor_result = executor.join().map_err(|_| ServerError::WorkerPanicked)?;

            {
                let mut runtime = self.lock_runtime()?;
                runtime.unsubscribe_events();
            }
            drop(output_sender);

            relay.join().map_err(|_| ServerError::WorkerPanicked)?;
            let writer_result = writer.join().map_err(|_| ServerError::WorkerPanicked)?;
            result.and(executor_result).and(writer_result)
        })
    }

    fn read_requests<R: BufRead>(
        &mut self,
        input: R,
        output: &SyncSender<ServerMessage>,
        executions: &SyncSender<ExecutionJob>,
    ) -> Result<(), ServerError> {
        for line in input.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<ClientMessage>(&line) {
                Ok(message) => self.handle_message(message, output, executions)?,
                Err(error) => self.respond(
                    output,
                    0,
                    Err(protocol_error(
                        ErrorCode::InvalidRequest,
                        format!("invalid client message: {error}"),
                    )),
                )?,
            }
        }
        Ok(())
    }

    fn handle_message(
        &mut self,
        message: ClientMessage,
        output: &SyncSender<ServerMessage>,
        executions: &SyncSender<ExecutionJob>,
    ) -> Result<(), ServerError> {
        let id = message.id;
        if let Command::Submit { session_id, text } = &message.command {
            return self.submit(id, session_id.clone(), text.clone(), output, executions);
        }
        let persist = matches!(
            &message.command,
            Command::CreateSession { .. }
                | Command::ForkSession { .. }
                | Command::RenameSession { .. }
                | Command::SetSessionTarget { .. }
                | Command::CancelExecution { .. }
        );

        let reply = match message.command {
            Command::Initialize { after_sequence } => self
                .refresh_all_catalogs()
                .map_err(map_backend_error)
                .and_then(|()| {
                    let runtime = self.lock_runtime().map_err(|error| {
                        protocol_error(ErrorCode::BackendProtocol, error.to_string())
                    })?;
                    Ok(Reply::Initialized {
                        snapshot: runtime.snapshot(),
                        events: runtime.events_since(after_sequence.unwrap_or(0)),
                        backends: self.catalogs(),
                    })
                }),
            Command::GetSnapshot => {
                let runtime = self.lock_runtime()?;
                Ok(Reply::Snapshot {
                    snapshot: runtime.snapshot(),
                    backends: self.catalogs(),
                })
            }
            Command::CreateSession {
                parent_session,
                name,
                target,
            } => self
                .lock_runtime()?
                .create_session(parent_session, name, target)
                .map(|session| Reply::Session { session })
                .map_err(map_conductor_error),
            Command::ForkSession { session_id, name } => self
                .lock_runtime()?
                .fork_session(&session_id, name)
                .map(|session| Reply::Session { session })
                .map_err(map_conductor_error),
            Command::RenameSession { session_id, name } => self
                .lock_runtime()?
                .rename_session(&session_id, name)
                .map(|session| Reply::Session { session })
                .map_err(map_conductor_error),
            Command::SetSessionTarget { session_id, target } => self
                .lock_runtime()?
                .set_session_target(&session_id, target)
                .map(|session| Reply::Session { session })
                .map_err(map_conductor_error),
            Command::CancelExecution { execution_id } => self.cancel_execution(&execution_id),
            Command::RefreshBackendCatalog { backend_id } => self
                .refresh_backend(&backend_id)
                .map(|catalog| Reply::BackendCatalog { catalog })
                .map_err(map_backend_error),
            Command::SelectAuthentication {
                backend_id,
                method_id,
            } => self
                .authenticate(&backend_id, &method_id)
                .map(|catalog| Reply::BackendCatalog { catalog })
                .map_err(map_backend_error),
            Command::Submit { .. } => unreachable!("submit handled before dispatch"),
        };

        self.respond(output, id, reply)?;
        if persist {
            self.persist()?;
        }
        Ok(())
    }

    fn submit(
        &mut self,
        request_id: u64,
        session_id: SessionId,
        text: String,
        output: &SyncSender<ServerMessage>,
        executions: &SyncSender<ExecutionJob>,
    ) -> Result<(), ServerError> {
        let execution = match self.lock_runtime()?.submit(&session_id, text) {
            Ok(execution) => execution,
            Err(error) => {
                self.respond(output, request_id, Err(map_conductor_error(error)))?;
                return Ok(());
            }
        };
        let execution_id = execution.id.clone();
        self.respond(
            output,
            request_id,
            Ok(Reply::Execution {
                execution: execution.clone(),
            }),
        )?;
        self.persist()?;

        let resolved = match self.lock_runtime()?.resolve_invocation(&execution_id) {
            Ok(resolved) => resolved,
            Err(error) => {
                self.fail_execution(&execution_id, map_conductor_error(error))?;
                self.persist()?;
                return Ok(());
            }
        };
        let backend_id = resolved.model.backend.clone();
        let Some(backend) = self.backends.get(&backend_id).cloned() else {
            self.fail_execution(
                &execution_id,
                map_backend_error(BackendError::Unsupported(format!(
                    "backend is not registered: {backend_id}"
                ))),
            )?;
            self.persist()?;
            return Ok(());
        };

        if executions.send(ExecutionJob { resolved, backend }).is_err() {
            self.fail_execution(
                &execution_id,
                protocol_error(
                    ErrorCode::BackendTransport,
                    "conductor execution worker is unavailable",
                ),
            )?;
            self.persist()?;
        }
        Ok(())
    }

    fn cancel_execution(&self, root: &ExecutionId) -> Result<Reply, ProtocolError> {
        let active = self
            .active_scopes
            .lock()
            .map_err(|_| protocol_error(ErrorCode::BackendProtocol, "active scope lock poisoned"))?
            .iter()
            .map(|(id, scope)| (id.clone(), scope.backend_session.clone()))
            .collect::<Vec<_>>();

        let cancelled_active = {
            let mut runtime = self.runtime.lock().map_err(|_| {
                protocol_error(
                    ErrorCode::BackendProtocol,
                    "conductor runtime lock poisoned",
                )
            })?;
            runtime
                .cancel_execution(root)
                .map_err(map_conductor_error)?;
            active
                .into_iter()
                .filter(|(id, _)| runtime.execution_state(id) == Some(ExecutionState::Cancelled))
                .collect::<Vec<_>>()
        };

        for (execution_id, session) in cancelled_active {
            match session.cancel(&execution_id) {
                Ok(()) | Err(BackendError::Unsupported(_)) => {}
                Err(error) => return Err(map_backend_error(error)),
            }
        }
        Ok(Reply::Accepted)
    }

    fn fail_execution(
        &self,
        execution_id: &ExecutionId,
        error: ProtocolError,
    ) -> Result<(), ServerError> {
        let mut runtime = self.lock_runtime()?;
        fail_runtime_execution(&mut runtime, execution_id, error)?;
        Ok(())
    }

    fn refresh_all_catalogs(&mut self) -> Result<(), BackendError> {
        let backend_ids = self.backends.keys().cloned().collect::<Vec<_>>();
        for backend_id in backend_ids {
            self.refresh_backend(&backend_id)?;
        }
        Ok(())
    }

    fn refresh_backend(&mut self, backend_id: &BackendId) -> Result<BackendCatalog, BackendError> {
        let backend = self.backends.get(backend_id).ok_or_else(|| {
            BackendError::Unsupported(format!("backend is not registered: {backend_id}"))
        })?;
        let catalog = backend
            .lock()
            .map_err(|_| BackendError::Transport("backend lock poisoned".to_owned()))?
            .catalog()?;
        if catalog.backend != *backend_id {
            return Err(BackendError::Protocol(format!(
                "backend catalog id {} does not match registry key {backend_id}",
                catalog.backend
            )));
        }
        self.catalogs.insert(backend_id.clone(), catalog.clone());
        Ok(catalog)
    }

    fn authenticate(
        &mut self,
        backend_id: &BackendId,
        method_id: &AuthenticationMethodId,
    ) -> Result<BackendCatalog, BackendError> {
        let backend = self.backends.get(backend_id).ok_or_else(|| {
            BackendError::Unsupported(format!("backend is not registered: {backend_id}"))
        })?;
        backend
            .lock()
            .map_err(|_| BackendError::Transport("backend lock poisoned".to_owned()))?
            .authenticate(method_id)?;
        self.refresh_backend(backend_id)
    }

    fn respond(
        &self,
        output: &SyncSender<ServerMessage>,
        id: u64,
        result: Result<Reply, ProtocolError>,
    ) -> Result<(), ServerError> {
        let response = match result {
            Ok(result) => ResponsePayload::Ok { result },
            Err(error) => ResponsePayload::Error { error },
        };
        output
            .send(ServerMessage::Response { id, response })
            .map_err(|_| ServerError::OutputClosed)
    }

    fn persist(&self) -> Result<(), ServerError> {
        persist_shared(&self.runtime, self.store.as_ref(), &self.persist_lock)?;
        Ok(())
    }

    fn lock_runtime(&self) -> Result<MutexGuard<'_, ConductorRuntime>, ServerError> {
        self.runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))
    }
}

fn execution_loop(
    executions: Receiver<ExecutionJob>,
    runtime: SharedRuntime,
    active_scopes: ActiveScopes,
    store: Option<JsonFileStore>,
    persist_lock: Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    while let Ok(job) = executions.recv() {
        execute_job(job, &runtime, &active_scopes, store.as_ref(), &persist_lock)?;
    }
    Ok(())
}

fn execute_job(
    job: ExecutionJob,
    runtime: &SharedRuntime,
    active_scopes: &ActiveScopes,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    let execution_id = job.resolved.execution_id.clone();
    let capabilities = job
        .backend
        .lock()
        .map_err(|_| ServerError::StatePoisoned("backend"))?
        .capabilities();
    let prepared = {
        let runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        runtime_guard.prepare_invocation(job.resolved, &capabilities)
    };
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            fail_shared_execution(
                runtime,
                &execution_id,
                map_conductor_error(error),
                store,
                persist_lock,
            )?;
            return Ok(());
        }
    };

    let backend_session = match job
        .backend
        .lock()
        .map_err(|_| ServerError::StatePoisoned("backend"))?
        .open_session(prepared.backend_session_request())
    {
        Ok(session) => session,
        Err(error) => {
            fail_shared_execution(
                runtime,
                &execution_id,
                map_backend_error(error),
                store,
                persist_lock,
            )?;
            return Ok(());
        }
    };

    active_scopes
        .lock()
        .map_err(|_| ServerError::StatePoisoned("active scopes"))?
        .insert(
            execution_id.clone(),
            LiveExecutionScope {
                backend_session: backend_session.clone(),
            },
        );
    let _scope_lease = LiveExecutionLease {
        scopes: active_scopes.clone(),
        execution_id: execution_id.clone(),
    };

    let should_execute = {
        let mut runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        match runtime_guard.execution_state(&execution_id) {
            Some(ExecutionState::Pending) => {
                runtime_guard.set_state(&execution_id, ExecutionState::Running)?;
                true
            }
            Some(state) if is_terminal_state(&state) => false,
            Some(_) => {
                fail_runtime_execution(
                    &mut runtime_guard,
                    &execution_id,
                    protocol_error(
                        ErrorCode::InvalidRequest,
                        format!("execution is not pending: {execution_id}"),
                    ),
                )?;
                false
            }
            None => false,
        }
    };
    persist_shared(runtime, store, persist_lock)?;

    if should_execute {
        let mut host = SharedRuntimeHost {
            runtime: runtime.clone(),
            execution_id: execution_id.clone(),
            allowed_tools: prepared.allowed_tools(),
            store: store.cloned(),
            persist_lock: persist_lock.clone(),
        };
        let result = backend_session.execute(prepared.backend_execution_request(), &mut host);

        let mut runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        if runtime_guard.execution_state(&execution_id) == Some(ExecutionState::Running) {
            match result {
                Ok(()) => runtime_guard.set_state(&execution_id, ExecutionState::Completed)?,
                Err(error) => fail_runtime_execution(
                    &mut runtime_guard,
                    &execution_id,
                    map_backend_error(error),
                )?,
            }
        }
        drop(runtime_guard);
        persist_shared(runtime, store, persist_lock)?;
    }

    Ok(())
}

fn fail_shared_execution(
    runtime: &SharedRuntime,
    execution_id: &ExecutionId,
    error: ProtocolError,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    {
        let mut runtime = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        fail_runtime_execution(&mut runtime, execution_id, error)?;
    }
    persist_shared(runtime, store, persist_lock)?;
    Ok(())
}

fn fail_runtime_execution(
    runtime: &mut ConductorRuntime,
    execution_id: &ExecutionId,
    error: ProtocolError,
) -> Result<(), ConductorError> {
    let Some(state) = runtime.execution_state(execution_id) else {
        return Err(ConductorError::UnknownExecution(execution_id.clone()));
    };
    if is_terminal_state(&state) {
        return Ok(());
    }
    runtime.push_event(
        execution_id,
        ExecutionEventKind::Error {
            code: format!("{:?}", error.code).to_lowercase(),
            message: error.message,
        },
    )?;
    runtime.set_state(execution_id, ExecutionState::Failed)
}

fn persist_shared(
    runtime: &SharedRuntime,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), PersistenceError> {
    let Some(store) = store else {
        return Ok(());
    };
    let _persist_guard = persist_lock
        .lock()
        .map_err(|_| PersistenceError::InvalidFormat("persistence lock poisoned".to_owned()))?;
    let checkpoint = runtime
        .lock()
        .map_err(|_| PersistenceError::InvalidFormat("runtime lock poisoned".to_owned()))?
        .checkpoint();
    store.save(&checkpoint)
}

struct SharedRuntimeHost {
    runtime: SharedRuntime,
    execution_id: ExecutionId,
    allowed_tools: BTreeSet<CallableId>,
    store: Option<JsonFileStore>,
    persist_lock: Arc<Mutex<()>>,
}

impl SharedRuntimeHost {
    fn persist(&self) -> Result<(), BackendError> {
        persist_shared(&self.runtime, self.store.as_ref(), &self.persist_lock).map_err(|error| {
            BackendError::Transport(format!("failed to persist conductor state: {error}"))
        })
    }

    fn lock_runtime(&self) -> Result<MutexGuard<'_, ConductorRuntime>, BackendError> {
        self.runtime
            .lock()
            .map_err(|_| BackendError::Protocol("conductor runtime lock poisoned".to_owned()))
    }
}

impl BackendHost for SharedRuntimeHost {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError> {
        {
            let mut runtime = self.lock_runtime()?;
            if runtime.execution_state(&self.execution_id) != Some(ExecutionState::Running) {
                return Err(BackendError::Protocol(format!(
                    "backend emitted an event after execution {} became terminal",
                    self.execution_id
                )));
            }
            let kind = match event {
                BackendEvent::ContentDelta(text) => {
                    ExecutionEventKind::AssistantContentDelta { text }
                }
                BackendEvent::ReasoningDelta(text) => ExecutionEventKind::ReasoningDelta { text },
            };
            runtime
                .push_event(&self.execution_id, kind)
                .map_err(|error| BackendError::Protocol(error.to_string()))?;
        }
        self.persist()
    }

    fn invoke_tool(&mut self, invocation: ToolInvocation) -> Result<ToolResult, BackendError> {
        let result = {
            let mut runtime = self.lock_runtime()?;
            if runtime.execution_state(&self.execution_id) != Some(ExecutionState::Running) {
                return Err(BackendError::Protocol(format!(
                    "backend invoked a tool after execution {} became terminal",
                    self.execution_id
                )));
            }
            runtime.invoke_tool(&self.execution_id, &self.allowed_tools, invocation)?
        };
        self.persist()?;
        Ok(result)
    }
}

impl ConductorRuntime {
    fn rename_session(
        &mut self,
        session_id: &SessionId,
        name: String,
    ) -> Result<phenix_core::SessionSummary, ConductorError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?;
        session.summary.name = Some(name);
        Ok(session.summary.clone())
    }

    fn set_session_target(
        &mut self,
        session_id: &SessionId,
        target: ExecutionTarget,
    ) -> Result<phenix_core::SessionSummary, ConductorError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?;
        session.summary.default_target = target;
        Ok(session.summary.clone())
    }

    fn interrupt_non_resumable_executions(&mut self) -> Result<(), ConductorError> {
        let running_model_executions = self
            .executions
            .iter()
            .filter(|(_, record)| {
                record.summary.state == ExecutionState::Running
                    && matches!(record.payload, ExecutionPayload::Model { .. })
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for execution_id in running_model_executions {
            self.set_state(&execution_id, ExecutionState::Interrupted)?;
        }
        Ok(())
    }

    fn execution_state(&self, execution_id: &ExecutionId) -> Option<ExecutionState> {
        self.executions
            .get(execution_id)
            .map(|record| record.summary.state.clone())
    }
}

fn is_terminal_state(state: &ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Completed
            | ExecutionState::Failed
            | ExecutionState::Cancelled
            | ExecutionState::Interrupted
    )
}

#[derive(Debug)]
pub enum ServerError {
    Io(io::Error),
    Json(serde_json::Error),
    Persistence(PersistenceError),
    Runtime(ConductorError),
    DuplicateBackend(BackendId),
    OutputClosed,
    StatePoisoned(&'static str),
    WorkerPanicked,
}

impl Display for ServerError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => Display::fmt(error, f),
            Self::Json(error) => Display::fmt(error, f),
            Self::Persistence(error) => Display::fmt(error, f),
            Self::Runtime(error) => Display::fmt(error, f),
            Self::DuplicateBackend(id) => write!(f, "backend already registered: {id}"),
            Self::OutputClosed => f.write_str("frontend output channel closed"),
            Self::StatePoisoned(name) => write!(f, "{name} lock poisoned"),
            Self::WorkerPanicked => f.write_str("frontend server worker panicked"),
        }
    }
}

impl Error for ServerError {}

impl From<io::Error> for ServerError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for ServerError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<PersistenceError> for ServerError {
    fn from(value: PersistenceError) -> Self {
        Self::Persistence(value)
    }
}

impl From<ConductorError> for ServerError {
    fn from(value: ConductorError) -> Self {
        Self::Runtime(value)
    }
}

fn protocol_error(code: ErrorCode, message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code,
        message: message.into(),
        session_id: None,
        execution_id: None,
    }
}

fn map_backend_error(error: BackendError) -> ProtocolError {
    match error {
        BackendError::Unsupported(message) => {
            protocol_error(ErrorCode::UnsupportedCapability, message)
        }
        BackendError::Transport(message) => protocol_error(ErrorCode::BackendTransport, message),
        BackendError::Protocol(message) => protocol_error(ErrorCode::BackendProtocol, message),
    }
}

fn map_conductor_error(error: ConductorError) -> ProtocolError {
    match error {
        ConductorError::UnknownSession(id) => {
            let mut error = protocol_error(ErrorCode::UnknownId, format!("unknown session: {id}"));
            error.session_id = Some(id);
            error
        }
        ConductorError::UnknownExecution(id) => {
            let mut error =
                protocol_error(ErrorCode::UnknownId, format!("unknown execution: {id}"));
            error.execution_id = Some(id);
            error
        }
        ConductorError::EmptyInput => {
            protocol_error(ErrorCode::InvalidRequest, "input must not be empty")
        }
        ConductorError::InvalidLifecycle(id) => {
            let mut error = protocol_error(
                ErrorCode::InvalidRequest,
                format!("invalid execution lifecycle: {id}"),
            );
            error.execution_id = Some(id);
            error
        }
        ConductorError::NonModelExecution(id) => {
            let mut error = protocol_error(
                ErrorCode::UnsupportedCapability,
                format!("execution is not model-backed: {id}"),
            );
            error.execution_id = Some(id);
            error
        }
        ConductorError::PolicyDenied {
            execution_id,
            denial,
        } => {
            let mut error = protocol_error(ErrorCode::PolicyDenied, denial.message);
            error.execution_id = Some(execution_id);
            error
        }
        ConductorError::CallableRegistry(error) => {
            protocol_error(ErrorCode::InvalidRequest, error.to_string())
        }
        ConductorError::Routing(error) => {
            protocol_error(ErrorCode::RoutingFailure, error.to_string())
        }
        ConductorError::Backend(error) => map_backend_error(error),
    }
}
