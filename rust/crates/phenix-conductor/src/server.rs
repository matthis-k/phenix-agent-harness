use crate::{
    ConductorError, ConductorRuntime, DomainEvent, ExecutionPayload, ExecutionProvider,
    ExecutionProviderError, ExecutionProviderEvent, ExecutionProviderHost, ExecutionProviderKind,
    JsonFileStore, PersistenceError,
};
use phenix_backend::{
    Backend, BackendError, BackendEvent, BackendHost, BackendSession, ToolInvocation, ToolResult,
};
use phenix_core::{
    AuthenticationMethodId, BackendCatalog, BackendId, CallableId, ExecutionEventKind, ExecutionId,
    ExecutionKind, ExecutionState, ExecutionTarget, SessionId, SessionState,
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
    execution_id: ExecutionId,
}

/// Process-local resources owned by one live execution. Durable execution state
/// remains in `ConductorRuntime`; this scope is deliberately not persisted.
#[derive(Clone)]
enum LiveExecutionScope {
    Backend(Arc<dyn BackendSession>),
    Provider(Arc<dyn ExecutionProvider>),
}

impl LiveExecutionScope {
    fn cancel(&self, execution_id: &ExecutionId) -> Result<(), ProtocolError> {
        match self {
            Self::Backend(session) => match session.cancel(execution_id) {
                Ok(()) | Err(BackendError::Unsupported(_)) => Ok(()),
                Err(error) => Err(map_backend_error(error)),
            },
            Self::Provider(provider) => match provider.cancel(execution_id) {
                Ok(()) | Err(ExecutionProviderError::Unsupported(_)) => Ok(()),
                Err(error) => Err(map_execution_provider_error(error)),
            },
        }
    }
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
            Ok(journal) => ConductorRuntime::restore(journal)?,
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
        let backends = self.backends.clone();
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
                    backends,
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
        match &message.command {
            Command::Submit { session_id, text } => {
                return self.submit(id, session_id.clone(), text.clone(), output, executions);
            }
            Command::StartCallable {
                session_id,
                callable,
                objective,
            } => {
                return self.start_callable(
                    id,
                    session_id.clone(),
                    callable.clone(),
                    objective.clone(),
                    output,
                    executions,
                );
            }
            Command::GetCallableCatalog => {
                let callables = self.lock_runtime()?.callable_descriptors();
                self.respond(output, id, Ok(Reply::CallableCatalog { callables }))?;
                return Ok(());
            }
            _ => {}
        }
        let persist = matches!(
            &message.command,
            Command::CreateSession { .. }
                | Command::ForkSession { .. }
                | Command::RenameSession { .. }
                | Command::SetSessionTarget { .. }
                | Command::CloseSession { .. }
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
            Command::CloseSession { session_id } => self.close_session(&session_id),
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
            Command::StartCallable { .. } => {
                unreachable!("callable start handled before dispatch")
            }
            Command::GetCallableCatalog => {
                unreachable!("callable catalog handled before dispatch")
            }
        };

        if persist {
            self.persist()?;
        }
        self.respond(output, id, reply)?;
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
        self.persist()?;
        self.respond(output, request_id, Ok(Reply::Execution { execution }))?;
        self.enqueue_execution(execution_id, executions)
    }

    fn start_callable(
        &mut self,
        request_id: u64,
        session_id: SessionId,
        callable: CallableId,
        objective: String,
        output: &SyncSender<ServerMessage>,
        executions: &SyncSender<ExecutionJob>,
    ) -> Result<(), ServerError> {
        let execution =
            match self
                .lock_runtime()?
                .start_session_callable(&session_id, &callable, objective)
            {
                Ok(execution) => execution,
                Err(error) => {
                    self.respond(output, request_id, Err(map_conductor_error(error)))?;
                    return Ok(());
                }
            };
        let execution_id = execution.id.clone();
        let execution_kind = execution.kind.clone();
        self.persist()?;
        self.respond(
            output,
            request_id,
            Ok(Reply::Execution {
                execution: execution.clone(),
            }),
        )?;

        if execution_kind == ExecutionKind::Workflow {
            let pending = {
                let runtime = self.lock_runtime()?;
                runtime
                    .snapshot()
                    .executions
                    .into_iter()
                    .filter(|candidate| {
                        candidate.parent_execution.as_ref() == Some(&execution_id)
                            && candidate.state == ExecutionState::Pending
                    })
                    .map(|candidate| candidate.id)
                    .collect::<Vec<_>>()
            };
            for child in pending {
                self.enqueue_execution(child, executions)?;
            }
            Ok(())
        } else {
            self.enqueue_execution(execution_id, executions)
        }
    }

    fn enqueue_execution(
        &self,
        execution_id: ExecutionId,
        executions: &SyncSender<ExecutionJob>,
    ) -> Result<(), ServerError> {
        if executions
            .send(ExecutionJob {
                execution_id: execution_id.clone(),
            })
            .is_err()
        {
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
            .map(|(id, scope)| (id.clone(), scope.clone()))
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

        for (execution_id, scope) in cancelled_active {
            scope.cancel(&execution_id)?;
        }
        Ok(Reply::Accepted)
    }

    fn close_session(&mut self, session_id: &SessionId) -> Result<Reply, ProtocolError> {
        let session = self
            .runtime
            .lock()
            .map_err(|_| {
                protocol_error(
                    ErrorCode::BackendProtocol,
                    "conductor runtime lock poisoned",
                )
            })?
            .validate_session_close(session_id)
            .map_err(map_conductor_error)?;
        if session.state == SessionState::Closed {
            return Ok(Reply::Session { session });
        }

        // Backend disposal precedes the durable close marker. A failed backend
        // therefore leaves the Phenix session active and retryable; backends are
        // required to make persistent close idempotent because earlier fanout
        // members may already have completed successfully.
        for backend in self.backends.values() {
            backend
                .lock()
                .map_err(|_| protocol_error(ErrorCode::BackendTransport, "backend lock poisoned"))?
                .close_persistent_session(session_id)
                .map_err(map_backend_error)?;
        }

        let session = self
            .runtime
            .lock()
            .map_err(|_| {
                protocol_error(
                    ErrorCode::BackendProtocol,
                    "conductor runtime lock poisoned",
                )
            })?
            .close_session(session_id)
            .map_err(map_conductor_error)?;
        Ok(Reply::Session { session })
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
    backends: BTreeMap<BackendId, SharedBackend>,
    active_scopes: ActiveScopes,
    store: Option<JsonFileStore>,
    persist_lock: Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    while let Ok(job) = executions.recv() {
        execute_job_chain(
            job.execution_id,
            &runtime,
            &backends,
            &active_scopes,
            store.as_ref(),
            &persist_lock,
        )?;
    }
    Ok(())
}

fn execute_job_chain(
    execution_id: ExecutionId,
    runtime: &SharedRuntime,
    backends: &BTreeMap<BackendId, SharedBackend>,
    active_scopes: &ActiveScopes,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    let mut current = Some(execution_id);
    while let Some(execution_id) = current {
        execute_execution(
            &execution_id,
            runtime,
            backends,
            active_scopes,
            store,
            persist_lock,
        )?;
        current = next_workflow_execution(runtime, &execution_id)?;
    }
    Ok(())
}

fn execute_execution(
    execution_id: &ExecutionId,
    runtime: &SharedRuntime,
    backends: &BTreeMap<BackendId, SharedBackend>,
    active_scopes: &ActiveScopes,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    let provider_kind = {
        let runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        match runtime_guard.execution_state(execution_id) {
            Some(ExecutionState::Pending) => runtime_guard.execution_provider_kind(execution_id),
            Some(state) if is_terminal_state(&state) => return Ok(()),
            Some(_) => return Ok(()),
            None => return Ok(()),
        }
    };
    let provider_kind = match provider_kind {
        Ok(kind) => kind,
        Err(error) => {
            fail_shared_execution(
                runtime,
                execution_id,
                map_conductor_error(error),
                store,
                persist_lock,
            )?;
            return Ok(());
        }
    };

    match provider_kind {
        ExecutionProviderKind::Model => execute_model_execution(
            execution_id,
            runtime,
            backends,
            active_scopes,
            store,
            persist_lock,
        ),
        _ => execute_provider_execution(execution_id, runtime, active_scopes, store, persist_lock),
    }
}

fn execute_model_execution(
    execution_id: &ExecutionId,
    runtime: &SharedRuntime,
    backends: &BTreeMap<BackendId, SharedBackend>,
    active_scopes: &ActiveScopes,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    let resolved = {
        let mut runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        runtime_guard.resolve_invocation(execution_id)
    };
    let resolved = match resolved {
        Ok(resolved) => resolved,
        Err(error) => {
            fail_shared_execution(
                runtime,
                execution_id,
                map_conductor_error(error),
                store,
                persist_lock,
            )?;
            return Ok(());
        }
    };
    // A routed decision is durable audit state. Persist it before any backend
    // session can observe or execute the resolved invocation.
    persist_shared(runtime, store, persist_lock)?;

    let backend_id = resolved.model.backend.clone();
    let Some(backend) = backends.get(&backend_id).cloned() else {
        fail_shared_execution(
            runtime,
            execution_id,
            map_backend_error(BackendError::Unsupported(format!(
                "backend is not registered: {backend_id}"
            ))),
            store,
            persist_lock,
        )?;
        return Ok(());
    };

    let capabilities = backend
        .lock()
        .map_err(|_| ServerError::StatePoisoned("backend"))?
        .capabilities();
    let prepared = {
        let runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        runtime_guard.prepare_invocation(resolved, &capabilities)
    };
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            fail_shared_execution(
                runtime,
                execution_id,
                map_conductor_error(error),
                store,
                persist_lock,
            )?;
            return Ok(());
        }
    };

    let backend_session = {
        let mut backend = backend
            .lock()
            .map_err(|_| ServerError::StatePoisoned("backend"))?;
        let request = prepared.backend_session_request();
        if capabilities.persistent_sessions
            && matches!(
                &prepared.resolved.requested_target,
                ExecutionTarget::Fixed(_)
            )
        {
            backend.open_persistent_session(&prepared.resolved.session_id, request)
        } else {
            backend.open_session(request)
        }
    };
    let backend_session = match backend_session {
        Ok(session) => session,
        Err(error) => {
            fail_shared_execution(
                runtime,
                execution_id,
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
            LiveExecutionScope::Backend(backend_session.clone()),
        );
    let _scope_lease = LiveExecutionLease {
        scopes: active_scopes.clone(),
        execution_id: execution_id.clone(),
    };

    if !begin_execution(runtime, execution_id, store, persist_lock)? {
        return Ok(());
    }

    let mut host = SharedRuntimeHost {
        runtime: runtime.clone(),
        execution_id: execution_id.clone(),
        allowed_tools: prepared.allowed_tools(),
        store: store.cloned(),
        persist_lock: persist_lock.clone(),
    };
    let result = backend_session.execute(prepared.backend_execution_request(), &mut host);
    finish_model_execution(runtime, execution_id, result, store, persist_lock)
}

fn execute_provider_execution(
    execution_id: &ExecutionId,
    runtime: &SharedRuntime,
    active_scopes: &ActiveScopes,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    let prepared = {
        let runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        runtime_guard.prepare_provider_execution(execution_id)
    };
    let (provider, request) = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            fail_shared_execution(
                runtime,
                execution_id,
                map_conductor_error(error),
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
            LiveExecutionScope::Provider(provider.clone()),
        );
    let _scope_lease = LiveExecutionLease {
        scopes: active_scopes.clone(),
        execution_id: execution_id.clone(),
    };

    if !begin_execution(runtime, execution_id, store, persist_lock)? {
        return Ok(());
    }

    let mut host = SharedProviderHost {
        runtime: runtime.clone(),
        execution_id: execution_id.clone(),
        store: store.cloned(),
        persist_lock: persist_lock.clone(),
    };
    let result = provider.execute(&request, &mut host);
    finish_provider_execution(runtime, execution_id, result, store, persist_lock)
}

fn begin_execution(
    runtime: &SharedRuntime,
    execution_id: &ExecutionId,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<bool, ServerError> {
    let should_execute = {
        let mut runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        match runtime_guard.execution_state(execution_id) {
            Some(ExecutionState::Pending) => {
                runtime_guard.set_state(execution_id, ExecutionState::Running)?;
                true
            }
            Some(state) if is_terminal_state(&state) => false,
            Some(_) => {
                fail_runtime_execution(
                    &mut runtime_guard,
                    execution_id,
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
    Ok(should_execute)
}

fn finish_model_execution(
    runtime: &SharedRuntime,
    execution_id: &ExecutionId,
    result: Result<(), BackendError>,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    {
        let mut runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        if runtime_guard.execution_state(execution_id) == Some(ExecutionState::Running) {
            match result {
                Ok(()) => runtime_guard.set_state(execution_id, ExecutionState::Completed)?,
                Err(error) => fail_runtime_execution(
                    &mut runtime_guard,
                    execution_id,
                    map_backend_error(error),
                )?,
            }
        }
    }
    persist_shared(runtime, store, persist_lock)?;
    Ok(())
}

fn finish_provider_execution(
    runtime: &SharedRuntime,
    execution_id: &ExecutionId,
    result: Result<(), ExecutionProviderError>,
    store: Option<&JsonFileStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    {
        let mut runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        if runtime_guard.execution_state(execution_id) == Some(ExecutionState::Running) {
            match result {
                Ok(()) => runtime_guard.set_state(execution_id, ExecutionState::Completed)?,
                Err(error) => fail_runtime_execution(
                    &mut runtime_guard,
                    execution_id,
                    map_execution_provider_error(error),
                )?,
            }
        }
    }
    persist_shared(runtime, store, persist_lock)?;
    Ok(())
}

fn next_workflow_execution(
    runtime: &SharedRuntime,
    completed_execution: &ExecutionId,
) -> Result<Option<ExecutionId>, ServerError> {
    let snapshot = runtime
        .lock()
        .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?
        .snapshot();
    let Some(parent_id) = snapshot
        .executions
        .iter()
        .find(|execution| execution.id == *completed_execution)
        .and_then(|execution| execution.parent_execution.clone())
    else {
        return Ok(None);
    };
    let parent_running = snapshot.executions.iter().any(|execution| {
        execution.id == parent_id
            && execution.kind == ExecutionKind::Workflow
            && execution.state == ExecutionState::Running
    });
    if !parent_running {
        return Ok(None);
    }
    Ok(snapshot
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&parent_id)
                && execution.state == ExecutionState::Pending
        })
        .map(|execution| execution.id))
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
        .map_err(|_| PersistenceError::InvalidJournal("persistence lock poisoned".to_owned()))?;
    let journal = runtime
        .lock()
        .map_err(|_| PersistenceError::InvalidJournal("runtime lock poisoned".to_owned()))?
        .journal()
        .clone();
    store.save(&journal)
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

struct SharedProviderHost {
    runtime: SharedRuntime,
    execution_id: ExecutionId,
    store: Option<JsonFileStore>,
    persist_lock: Arc<Mutex<()>>,
}

impl SharedProviderHost {
    fn persist(&self) -> Result<(), ExecutionProviderError> {
        persist_shared(&self.runtime, self.store.as_ref(), &self.persist_lock).map_err(|error| {
            ExecutionProviderError::Failed(format!("failed to persist conductor state: {error}"))
        })
    }

    fn lock_runtime(&self) -> Result<MutexGuard<'_, ConductorRuntime>, ExecutionProviderError> {
        self.runtime.lock().map_err(|_| {
            ExecutionProviderError::Protocol("conductor runtime lock poisoned".to_owned())
        })
    }
}

impl ExecutionProviderHost for SharedProviderHost {
    fn emit(&mut self, event: ExecutionProviderEvent) -> Result<(), ExecutionProviderError> {
        {
            let mut runtime = self.lock_runtime()?;
            if runtime.execution_state(&self.execution_id) != Some(ExecutionState::Running) {
                return Err(ExecutionProviderError::Protocol(format!(
                    "provider emitted an event after execution {} became terminal",
                    self.execution_id
                )));
            }
            let kind = match event {
                ExecutionProviderEvent::ContentDelta(text) => {
                    ExecutionEventKind::AssistantContentDelta { text }
                }
                ExecutionProviderEvent::ReasoningDelta(text) => {
                    ExecutionEventKind::ReasoningDelta { text }
                }
            };
            runtime
                .push_event(&self.execution_id, kind)
                .map_err(|error| ExecutionProviderError::Protocol(error.to_string()))?;
        }
        self.persist()
    }
}

impl ConductorRuntime {
    fn rename_session(
        &mut self,
        session_id: &SessionId,
        name: String,
    ) -> Result<phenix_core::SessionSummary, ConductorError> {
        self.ensure_session_active(session_id)?;
        self.record_domain_event(DomainEvent::SessionRenamed {
            session_id: session_id.clone(),
            name,
        })?;
        Ok(self
            .sessions
            .get(session_id)
            .expect("renamed session remains present")
            .summary
            .clone())
    }

    fn set_session_target(
        &mut self,
        session_id: &SessionId,
        target: ExecutionTarget,
    ) -> Result<phenix_core::SessionSummary, ConductorError> {
        self.ensure_session_active(session_id)?;
        self.record_domain_event(DomainEvent::SessionTargetChanged {
            session_id: session_id.clone(),
            target,
        })?;
        Ok(self
            .sessions
            .get(session_id)
            .expect("retargeted session remains present")
            .summary
            .clone())
    }

    fn interrupt_non_resumable_executions(&mut self) -> Result<(), ConductorError> {
        let running_invocations = self
            .executions
            .iter()
            .filter(|(_, record)| {
                record.summary.state == ExecutionState::Running
                    && matches!(record.payload, ExecutionPayload::Invocation { .. })
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for execution_id in running_invocations {
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

fn map_execution_provider_error(error: ExecutionProviderError) -> ProtocolError {
    match error {
        ExecutionProviderError::Unsupported(message) => {
            protocol_error(ErrorCode::UnsupportedCapability, message)
        }
        ExecutionProviderError::Failed(message) | ExecutionProviderError::Protocol(message) => {
            protocol_error(ErrorCode::ExecutionProviderFailure, message)
        }
    }
}

fn map_conductor_error(error: ConductorError) -> ProtocolError {
    match error {
        ConductorError::UnknownSession(id) => {
            let mut error = protocol_error(ErrorCode::UnknownId, format!("unknown session: {id}"));
            error.session_id = Some(id);
            error
        }
        ConductorError::ClosedSession(id) => {
            let mut error = protocol_error(
                ErrorCode::InvalidRequest,
                format!("session is closed: {id}"),
            );
            error.session_id = Some(id);
            error
        }
        ConductorError::SessionHasActiveExecutions(id) => {
            let mut error = protocol_error(
                ErrorCode::InvalidRequest,
                format!("session has active executions and cannot close: {id}"),
            );
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
        ConductorError::NonProviderExecution(id) => {
            let mut error = protocol_error(
                ErrorCode::UnsupportedCapability,
                format!("execution is not provider-backed: {id}"),
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
        ConductorError::ExecutionProvider(error) => map_execution_provider_error(error),
        ConductorError::Journal(error) => {
            protocol_error(ErrorCode::BackendProtocol, error.to_string())
        }
        ConductorError::Routing(error) => {
            protocol_error(ErrorCode::RoutingFailure, error.to_string())
        }
        ConductorError::Backend(error) => map_backend_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::{BackendExecutionRequest, BackendSessionRequest};
    use phenix_core::{
        CallableDescriptor, CallableKind, CallablePolicy, CapabilitySet, InferenceOptions, ModelId,
        ModelTarget, ProviderId, WorkflowDefinition, WorkflowExecutionPolicy, WorkflowStep,
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CancelOnlySession {
        calls: Arc<AtomicUsize>,
    }

    impl BackendSession for CancelOnlySession {
        fn execute(
            &self,
            _request: BackendExecutionRequest,
            _host: &mut dyn BackendHost,
        ) -> Result<(), BackendError> {
            Ok(())
        }

        fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), BackendError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn model_target() -> ModelTarget {
        ModelTarget {
            backend: BackendId::parse("fixture").unwrap(),
            provider: ProviderId::parse("fixture").unwrap(),
            model: ModelId::parse("fixture-model").unwrap(),
            inference: InferenceOptions::default(),
        }
    }

    fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind,
            description: "server cancellation fixture".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    #[test]
    fn cancelling_root_reaches_active_descendant_scope_without_crossing_unrelated_execution() {
        let descendant_calls = Arc::new(AtomicUsize::new(0));
        let unrelated_calls = Arc::new(AtomicUsize::new(0));
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(descriptor("agent.child", CallableKind::Agent))
            .unwrap();
        runtime
            .register_workflow(WorkflowDefinition {
                descriptor: descriptor("workflow.tree", CallableKind::Workflow),
                policy: WorkflowExecutionPolicy::Sequential,
                steps: vec![WorkflowStep {
                    callable: CallableId::parse("agent.child").unwrap(),
                    objective: Some("child".to_owned()),
                }],
            })
            .unwrap();

        let session = runtime
            .create_session(None, None, ExecutionTarget::Fixed(model_target()))
            .unwrap();
        let root = runtime.submit(&session.id, "root").unwrap();
        let workflow = runtime
            .start_workflow(
                &root.id,
                &CallableId::parse("workflow.tree").unwrap(),
                "tree",
            )
            .unwrap();
        let child = runtime
            .snapshot()
            .executions
            .into_iter()
            .find(|execution| execution.parent_execution.as_ref() == Some(&workflow.id))
            .unwrap();
        runtime
            .set_state(&child.id, ExecutionState::Running)
            .unwrap();

        let unrelated_session = runtime
            .create_session(None, None, ExecutionTarget::Fixed(model_target()))
            .unwrap();
        let unrelated = runtime.submit(&unrelated_session.id, "unrelated").unwrap();
        runtime
            .set_state(&unrelated.id, ExecutionState::Running)
            .unwrap();

        let server = ConductorServer::new(runtime);
        {
            let mut scopes = server.active_scopes.lock().unwrap();
            scopes.insert(
                child.id.clone(),
                LiveExecutionScope::Backend(Arc::new(CancelOnlySession {
                    calls: descendant_calls.clone(),
                })),
            );
            scopes.insert(
                unrelated.id.clone(),
                LiveExecutionScope::Backend(Arc::new(CancelOnlySession {
                    calls: unrelated_calls.clone(),
                })),
            );
        }

        assert_eq!(server.cancel_execution(&root.id).unwrap(), Reply::Accepted);
        assert_eq!(descendant_calls.load(Ordering::SeqCst), 1);
        assert_eq!(unrelated_calls.load(Ordering::SeqCst), 0);

        let runtime = server.runtime();
        for id in [&root.id, &workflow.id, &child.id] {
            assert_eq!(runtime.execution_state(id), Some(ExecutionState::Cancelled));
        }
        assert_eq!(
            runtime.execution_state(&unrelated.id),
            Some(ExecutionState::Running)
        );
    }

    #[test]
    fn cancel_only_session_type_satisfies_backend_session_contract() {
        let session: Arc<dyn BackendSession> = Arc::new(CancelOnlySession {
            calls: Arc::new(AtomicUsize::new(0)),
        });
        let _ = BackendSessionRequest {
            model: model_target(),
            tools: phenix_backend::ToolProvision::default()
                .prepare(&phenix_backend::BackendCapabilities {
                    tool_presentations: BTreeSet::new(),
                    images: false,
                    persistent_sessions: false,
                })
                .unwrap(),
        };
        assert!(Arc::strong_count(&session) >= 1);
    }
}
