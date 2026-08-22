use crate::{
    CompiledConfiguration, ConductorError, ConductorRuntime, DomainEvent, ExecutionPayload,
    ExecutionProvider, ExecutionProviderError, ExecutionProviderEvent, ExecutionProviderHost,
    ExecutionProviderKind, PersistenceError, SqliteStore,
};
use phenix_backend::{
    Backend, BackendError, BackendEvent, BackendHost, BackendSession, ToolInvocation, ToolResult,
};
use phenix_core::{
    AuthenticationInput, AuthenticationMethodId, BackendCatalog, BackendId, CallableId,
    ExecutionEventKind, ExecutionId, ExecutionState, ExecutionTarget, FileVersion, SessionId,
    SessionState, WorkspaceDescriptor, WorkspaceId, WorkspaceLeaseMode,
};
use phenix_protocol::{
    ClientMessage, Command, ErrorCode, ProtocolError, Reply, ResponsePayload, ServerMessage,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{
    mpsc::{self, SyncSender},
    Arc, Condvar, Mutex, MutexGuard,
};
use std::thread;

#[path = "semantic_tools.rs"]
mod semantic_tools;
#[path = "workspace_consistency.rs"]
mod workspace_consistency;
#[path = "workspace_lease.rs"]
mod workspace_lease;
#[path = "workspace_tools.rs"]
mod workspace_tools;

use workspace_consistency::{WorkspaceConsistency, WorkspaceConsistencyError};
use workspace_lease::{WorkspaceLeaseError, WorkspaceLeaseManager};

const EVENT_BUFFER: usize = 256;
const OUTPUT_BUFFER: usize = 256;
const EXECUTION_WORKERS: usize = 4;
const IN_MEMORY_WORKSPACE_ID: &str = "workspace:in-memory";

type SharedBackend = Arc<Mutex<Box<dyn Backend>>>;
type SharedRuntime = Arc<Mutex<ConductorRuntime>>;
type ActiveScopes = Arc<Mutex<BTreeMap<ExecutionId, LiveExecutionScope>>>;
type WorkspacePhases = Arc<Mutex<BTreeMap<ExecutionId, WorkspacePhase>>>;

#[derive(Clone)]
struct ExecutionWorkerContext {
    runtime: SharedRuntime,
    backends: BTreeMap<BackendId, SharedBackend>,
    active_scopes: ActiveScopes,
    workspace_leases: WorkspaceLeaseManager,
    workspace_phases: WorkspacePhases,
    workspace_consistency: Option<WorkspaceConsistency>,
    store: Option<SqliteStore>,
    persist_lock: Arc<Mutex<()>>,
}

struct ExecutionJob {
    execution_id: ExecutionId,
    session_id: SessionId,
    group_id: ExecutionId,
}

#[derive(Default)]
struct WorkspacePhase {
    writing: bool,
}

impl WorkspacePhase {
    fn enter(&mut self, mode: WorkspaceLeaseMode) -> bool {
        match mode {
            WorkspaceLeaseMode::Read => {
                self.writing = false;
                false
            }
            WorkspaceLeaseMode::Write => {
                let starts_write_phase = !self.writing;
                self.writing = true;
                starts_write_phase
            }
        }
    }
}

#[derive(Default)]
struct ExecutionQueueState {
    pending: VecDeque<ExecutionJob>,
    active_sessions: BTreeMap<SessionId, ExecutionId>,
    active_groups: BTreeMap<ExecutionId, usize>,
    scheduled: BTreeSet<ExecutionId>,
    releasing_groups: BTreeSet<ExecutionId>,
    closed: bool,
}

#[derive(Clone, Default)]
struct ExecutionQueue {
    state: Arc<(Mutex<ExecutionQueueState>, Condvar)>,
}

impl ExecutionQueue {
    fn enqueue(&self, job: ExecutionJob) -> Result<(), ServerError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        if !state.scheduled.insert(job.execution_id.clone()) {
            return Ok(());
        }
        state.pending.push_back(job);
        ready.notify_all();
        Ok(())
    }

    fn next(&self) -> Result<Option<ExecutionJob>, ServerError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        loop {
            if let Some(index) = state.pending.iter().position(|job| {
                state
                    .active_sessions
                    .get(&job.session_id)
                    .is_none_or(|group| group == &job.group_id)
            }) {
                let job = state
                    .pending
                    .remove(index)
                    .expect("pending execution index was selected");
                state
                    .active_sessions
                    .entry(job.session_id.clone())
                    .or_insert_with(|| job.group_id.clone());
                *state.active_groups.entry(job.group_id.clone()).or_default() += 1;
                return Ok(Some(job));
            }
            if state.closed && state.pending.is_empty() && state.active_groups.is_empty() {
                return Ok(None);
            }
            state = ready
                .wait(state)
                .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        }
    }

    fn complete(&self, job: &ExecutionJob, release_group: bool) -> Result<bool, ServerError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        if release_group {
            state.releasing_groups.insert(job.group_id.clone());
        }
        let remove_group = {
            let active = state
                .active_groups
                .get_mut(&job.group_id)
                .expect("completed execution belongs to an active group");
            *active -= 1;
            *active == 0
        };
        if remove_group {
            state.active_groups.remove(&job.group_id);
        }
        let group_released = state.releasing_groups.contains(&job.group_id)
            && !state.active_groups.contains_key(&job.group_id)
            && !state
                .pending
                .iter()
                .any(|pending| pending.group_id == job.group_id)
            && state.active_sessions.get(&job.session_id) == Some(&job.group_id);
        if group_released {
            state.active_sessions.remove(&job.session_id);
            state.releasing_groups.remove(&job.group_id);
        }
        ready.notify_all();
        Ok(group_released)
    }

    fn close(&self) -> Result<(), ServerError> {
        let (lock, ready) = &*self.state;
        let mut state = lock
            .lock()
            .map_err(|_| ServerError::StatePoisoned("execution queue"))?;
        state.closed = true;
        ready.notify_all();
        Ok(())
    }
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
    workspace_leases: WorkspaceLeaseManager,
    workspace_consistency: Option<WorkspaceConsistency>,
    store: Option<SqliteStore>,
    persist_lock: Arc<Mutex<()>>,
}

#[derive(Clone)]
pub struct ConductorService {
    inner: Arc<ConductorServiceInner>,
}

struct ConductorServiceInner {
    server: Mutex<ConductorServer>,
    executions: ExecutionQueue,
    workers: Mutex<Vec<thread::JoinHandle<Result<(), ServerError>>>>,
}

impl Drop for ConductorServiceInner {
    fn drop(&mut self) {
        let _ = self.executions.close();
        if let Ok(workers) = self.workers.get_mut() {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
        }
    }
}

impl ConductorService {
    pub fn new(server: ConductorServer) -> Result<Self, ServerError> {
        let executions = ExecutionQueue::default();
        for root in server.lock_runtime()?.pending_roots_in_ingress_order() {
            executions.enqueue(ExecutionJob {
                execution_id: root.id.clone(),
                session_id: root.session_id,
                group_id: root.id,
            })?;
        }
        let context = server.worker_context();
        let workers = (0..EXECUTION_WORKERS)
            .map(|_| {
                let executions = executions.clone();
                let context = context.clone();
                thread::spawn(move || execution_loop(executions, context))
            })
            .collect();
        Ok(Self {
            inner: Arc::new(ConductorServiceInner {
                server: Mutex::new(server),
                executions,
                workers: Mutex::new(workers),
            }),
        })
    }

    pub fn serve_connection<R, W>(&self, input: R, output: W) -> Result<(), ServerError>
    where
        R: BufRead,
        W: Write + Send,
    {
        let (subscription, event_receiver) = {
            let server = self
                .inner
                .server
                .lock()
                .map_err(|_| ServerError::StatePoisoned("conductor service"))?;
            let subscription = server
                .runtime
                .lock()
                .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?
                .subscribe_events_with_id(EVENT_BUFFER);
            subscription
        };
        let (output_sender, output_receiver) = mpsc::sync_channel(OUTPUT_BUFFER);

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

            let result = (|| {
                for line in input.lines() {
                    let line = line?;
                    if line.trim().is_empty() {
                        continue;
                    }
                    let mut server = self
                        .inner
                        .server
                        .lock()
                        .map_err(|_| ServerError::StatePoisoned("conductor service"))?;
                    match serde_json::from_str::<ClientMessage>(&line) {
                        Ok(message) => server.handle_message(
                            message,
                            &output_sender,
                            &self.inner.executions,
                        )?,
                        Err(error) => server.respond(
                            &output_sender,
                            0,
                            Err(protocol_error(
                                ErrorCode::InvalidRequest,
                                format!("invalid client message: {error}"),
                            )),
                        )?,
                    }
                }
                Ok(())
            })();

            if let Ok(server) = self.inner.server.lock() {
                if let Ok(mut runtime) = server.runtime.lock() {
                    runtime.unsubscribe_event_subscription(subscription);
                }
            }
            drop(output_sender);
            relay.join().map_err(|_| ServerError::WorkerPanicked)?;
            let writer_result = writer.join().map_err(|_| ServerError::WorkerPanicked)?;
            normal_frontend_disconnect(result).and(normal_frontend_disconnect(writer_result))
        })
    }
}

fn normal_frontend_disconnect(result: Result<(), ServerError>) -> Result<(), ServerError> {
    match result {
        Err(ServerError::Io(error)) if is_disconnect_kind(error.kind()) => Ok(()),
        Err(ServerError::Json(error)) if error.io_error_kind().is_some_and(is_disconnect_kind) => {
            Ok(())
        }
        Err(ServerError::OutputClosed) => Ok(()),
        result => result,
    }
}

fn is_disconnect_kind(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::NotConnected
            | io::ErrorKind::UnexpectedEof
    )
}

impl ConductorServer {
    #[must_use]
    pub fn new(runtime: ConductorRuntime) -> Self {
        Self {
            runtime: Arc::new(Mutex::new(runtime)),
            backends: BTreeMap::new(),
            catalogs: BTreeMap::new(),
            active_scopes: Arc::new(Mutex::new(BTreeMap::new())),
            workspace_leases: WorkspaceLeaseManager::default(),
            workspace_consistency: None,
            store: None,
            persist_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn load_or_new(store: SqliteStore, workspace_id: WorkspaceId) -> Result<Self, ServerError> {
        let runtime = match store.load() {
            Ok(journal) => {
                let mut runtime = ConductorRuntime::restore(journal)?;
                runtime.bind_workspace(workspace_id.clone())?;
                runtime
            }
            Err(PersistenceError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                let mut runtime = ConductorRuntime::new();
                runtime.bind_workspace(workspace_id)?;
                runtime
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

    pub fn install_workspace_consistency(
        &mut self,
        descriptor: WorkspaceDescriptor,
    ) -> Result<(), ServerError> {
        let consistency = WorkspaceConsistency::new(&descriptor)?;
        self.lock_runtime()?.bind_workspace(descriptor.id)?;
        self.workspace_consistency = Some(consistency);
        Ok(())
    }

    pub fn install_workspace_tools_into(
        &self,
        configuration: &mut CompiledConfiguration,
    ) -> Result<(), ServerError> {
        let consistency = self
            .workspace_consistency
            .clone()
            .ok_or(ServerError::WorkspaceConsistencyNotInstalled)?;
        workspace_tools::register_into(configuration, consistency)?;
        Ok(())
    }

    pub fn install_workspace_tools(&mut self) -> Result<(), ServerError> {
        let consistency = self
            .workspace_consistency
            .clone()
            .ok_or(ServerError::WorkspaceConsistencyNotInstalled)?;
        let mut runtime = self.lock_runtime()?;
        workspace_tools::register(&mut runtime, consistency)?;
        Ok(())
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
        let (event_subscription, event_receiver) = {
            let mut runtime = self.lock_runtime()?;
            runtime.subscribe_events_with_id(EVENT_BUFFER)
        };
        let (output_sender, output_receiver) = mpsc::sync_channel(OUTPUT_BUFFER);
        let executions = ExecutionQueue::default();
        let worker_context = ExecutionWorkerContext {
            runtime: self.runtime.clone(),
            backends: self.backends.clone(),
            active_scopes: self.active_scopes.clone(),
            workspace_leases: self.workspace_leases.clone(),
            workspace_phases: Arc::new(Mutex::new(BTreeMap::new())),
            workspace_consistency: self.workspace_consistency.clone(),
            store: self.store.clone(),
            persist_lock: self.persist_lock.clone(),
        };

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

            let executors = (0..EXECUTION_WORKERS)
                .map(|_| {
                    let executions = executions.clone();
                    let context = worker_context.clone();
                    scope.spawn(move || execution_loop(executions, context))
                })
                .collect::<Vec<_>>();

            let result = self.read_requests(input, &output_sender, &executions);
            executions.close()?;
            let mut executor_result = Ok(());
            for executor in executors {
                let worker_result = executor.join().map_err(|_| ServerError::WorkerPanicked)?;
                if executor_result.is_ok() {
                    executor_result = worker_result;
                }
            }

            {
                let mut runtime = self.lock_runtime()?;
                runtime.unsubscribe_event_subscription(event_subscription);
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
        executions: &ExecutionQueue,
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
        executions: &ExecutionQueue,
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
                let callables = self.lock_runtime()?.callable_descriptors()?;
                self.respond(output, id, Ok(Reply::CallableCatalog { callables }))?;
                return Ok(());
            }
            Command::GetRoutingCatalog => {
                let profiles = self.lock_runtime()?.routing_profiles()?;
                self.respond(output, id, Ok(Reply::RoutingCatalog { profiles }))?;
                return Ok(());
            }
            Command::GetSkillCatalog => {
                let skills = self.lock_runtime()?.skill_descriptors()?;
                self.respond(output, id, Ok(Reply::SkillCatalog { skills }))?;
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
                | Command::RebaseSession { .. }
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
            Command::RebaseSession {
                session_id,
                config_revision,
            } => self
                .lock_runtime()?
                .rebase_session(&session_id, &config_revision)
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
                input,
            } => self
                .authenticate(&backend_id, &method_id, input.as_ref())
                .map(|catalog| Reply::BackendCatalog { catalog })
                .map_err(map_backend_error),
            Command::Submit { .. } => unreachable!("submit handled before dispatch"),
            Command::StartCallable { .. } => {
                unreachable!("callable start handled before dispatch")
            }
            Command::GetCallableCatalog => {
                unreachable!("callable catalog handled before dispatch")
            }
            Command::GetRoutingCatalog => {
                unreachable!("routing catalog handled before dispatch")
            }
            Command::GetSkillCatalog => {
                unreachable!("skill catalog handled before dispatch")
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
        executions: &ExecutionQueue,
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
        enqueue_pending_execution_group(&self.runtime, &execution_id, executions)
    }

    fn start_callable(
        &mut self,
        request_id: u64,
        session_id: SessionId,
        callable: CallableId,
        objective: String,
        output: &SyncSender<ServerMessage>,
        executions: &ExecutionQueue,
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
        self.persist()?;
        self.respond(
            output,
            request_id,
            Ok(Reply::Execution {
                execution: execution.clone(),
            }),
        )?;
        enqueue_pending_execution_group(&self.runtime, &execution_id, executions)
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
        input: Option<&AuthenticationInput>,
    ) -> Result<BackendCatalog, BackendError> {
        let backend = self.backends.get(backend_id).ok_or_else(|| {
            BackendError::Unsupported(format!("backend is not registered: {backend_id}"))
        })?;
        backend
            .lock()
            .map_err(|_| BackendError::Transport("backend lock poisoned".to_owned()))?
            .authenticate_with_input(method_id, input)?;
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

    fn worker_context(&self) -> ExecutionWorkerContext {
        ExecutionWorkerContext {
            runtime: self.runtime.clone(),
            backends: self.backends.clone(),
            active_scopes: self.active_scopes.clone(),
            workspace_leases: self.workspace_leases.clone(),
            workspace_phases: Arc::new(Mutex::new(BTreeMap::new())),
            workspace_consistency: self.workspace_consistency.clone(),
            store: self.store.clone(),
            persist_lock: self.persist_lock.clone(),
        }
    }
}

fn execution_loop(
    executions: ExecutionQueue,
    context: ExecutionWorkerContext,
) -> Result<(), ServerError> {
    while let Some(job) = executions.next()? {
        let result = execute_execution(&job.execution_id, &job.group_id, &context).and_then(|()| {
            enqueue_pending_execution_group(&context.runtime, &job.group_id, &executions)
        });
        let group_quiescent = execution_group_quiescent(&context.runtime, &job.group_id);
        let release_group =
            result.is_err() || group_quiescent.as_ref().map_or(true, |value| *value);
        let group_released = executions.complete(&job, release_group)?;
        if group_released {
            context
                .workspace_phases
                .lock()
                .map_err(|_| ServerError::StatePoisoned("workspace phases"))?
                .remove(&job.group_id);
        }
        result?;
        group_quiescent?;
    }
    Ok(())
}

fn enqueue_pending_execution_group(
    runtime: &SharedRuntime,
    group_id: &ExecutionId,
    executions: &ExecutionQueue,
) -> Result<(), ServerError> {
    for job in pending_execution_jobs(runtime, group_id)? {
        executions.enqueue(job)?;
    }
    Ok(())
}

fn pending_execution_jobs(
    runtime: &SharedRuntime,
    group_id: &ExecutionId,
) -> Result<Vec<ExecutionJob>, ServerError> {
    let snapshot = runtime
        .lock()
        .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?
        .snapshot();
    Ok(snapshot
        .executions
        .iter()
        .filter(|execution| {
            execution.state == ExecutionState::Pending
                && execution_group_id(&snapshot.executions, &execution.id).as_ref()
                    == Some(group_id)
                && !execution_has_blocking_ancestor(&snapshot.executions, &execution.id)
        })
        .map(|execution| ExecutionJob {
            execution_id: execution.id.clone(),
            session_id: execution.session_id.clone(),
            group_id: group_id.clone(),
        })
        .collect())
}

fn execution_group_quiescent(
    runtime: &SharedRuntime,
    group_id: &ExecutionId,
) -> Result<bool, ServerError> {
    let snapshot = runtime
        .lock()
        .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?
        .snapshot();
    let mut found = false;
    for execution in &snapshot.executions {
        if execution_group_id(&snapshot.executions, &execution.id).as_ref() != Some(group_id) {
            continue;
        }
        found = true;
        match execution.state {
            ExecutionState::Running => return Ok(false),
            ExecutionState::Pending
                if !execution_has_blocking_ancestor(&snapshot.executions, &execution.id) =>
            {
                return Ok(false);
            }
            _ => {}
        }
    }
    Ok(found)
}

fn execution_group_id(
    executions: &[phenix_core::ExecutionSummary],
    execution_id: &ExecutionId,
) -> Option<ExecutionId> {
    let mut current = execution_id.clone();
    loop {
        let execution = executions
            .iter()
            .find(|execution| execution.id == current)?;
        let Some(parent) = execution.parent_execution.as_ref() else {
            return Some(current);
        };
        current = parent.clone();
    }
}

fn execution_has_blocking_ancestor(
    executions: &[phenix_core::ExecutionSummary],
    execution_id: &ExecutionId,
) -> bool {
    let mut parent = executions
        .iter()
        .find(|execution| execution.id == *execution_id)
        .and_then(|execution| execution.parent_execution.clone());
    while let Some(parent_id) = parent {
        let Some(parent_execution) = executions
            .iter()
            .find(|execution| execution.id == parent_id)
        else {
            return true;
        };
        if matches!(
            parent_execution.state,
            ExecutionState::Failed | ExecutionState::Cancelled | ExecutionState::Interrupted
        ) {
            return true;
        }
        parent = parent_execution.parent_execution.clone();
    }
    false
}

fn execute_execution(
    execution_id: &ExecutionId,
    group_id: &ExecutionId,
    context: &ExecutionWorkerContext,
) -> Result<(), ServerError> {
    let runtime = &context.runtime;
    let backends = &context.backends;
    let active_scopes = &context.active_scopes;
    let workspace_leases = &context.workspace_leases;
    let workspace_consistency = context.workspace_consistency.as_ref();
    let store = context.store.as_ref();
    let persist_lock = &context.persist_lock;

    let lease_request = {
        let runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        match runtime_guard.execution_state(execution_id) {
            Some(ExecutionState::Pending) => {
                let snapshot = runtime_guard.snapshot();
                if execution_has_blocking_ancestor(&snapshot.executions, execution_id) {
                    return Ok(());
                }
                runtime_guard.workspace_lease_request(execution_id)
            }
            Some(state) if is_terminal_state(&state) => return Ok(()),
            Some(_) => return Ok(()),
            None => return Ok(()),
        }
    };
    let lease_request = match lease_request {
        Ok(request) => request,
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
    let workspace_id = lease_request.workspace_id.clone();
    let lease_mode = lease_request.mode;
    let _workspace_lease = workspace_leases.acquire(lease_request)?;
    let starts_write_phase = context
        .workspace_phases
        .lock()
        .map_err(|_| ServerError::StatePoisoned("workspace phases"))?
        .entry(group_id.clone())
        .or_default()
        .enter(lease_mode);

    if starts_write_phase && workspace_id.as_str() != IN_MEMORY_WORKSPACE_ID {
        let consistency = workspace_consistency
            .ok_or_else(|| ServerError::WorkspaceConsistencyUnavailable(workspace_id.clone()))?;
        let files = consistency.checkpoint_baseline()?;
        {
            let mut runtime_guard = runtime
                .lock()
                .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
            runtime_guard.record_workspace_checkpoint(execution_id, workspace_id, files)?;
        }
        persist_shared(runtime, store, persist_lock)?;
    }

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
    store: Option<&SqliteStore>,
    persist_lock: &Arc<Mutex<()>>,
) -> Result<(), ServerError> {
    let resolved = {
        let mut runtime_guard = runtime
            .lock()
            .map_err(|_| ServerError::StatePoisoned("conductor runtime"))?;
        let mut resolved = runtime_guard.resolve_invocation(execution_id);
        if let Ok(invocation) = &mut resolved {
            if let Err(error) = semantic_tools::extend_semantic_tools(&runtime_guard, invocation) {
                resolved = Err(error);
            }
        }
        resolved
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
    store: Option<&SqliteStore>,
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
    store: Option<&SqliteStore>,
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
    store: Option<&SqliteStore>,
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
    store: Option<&SqliteStore>,
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

fn fail_shared_execution(
    runtime: &SharedRuntime,
    execution_id: &ExecutionId,
    error: ProtocolError,
    store: Option<&SqliteStore>,
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
    store: Option<&SqliteStore>,
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
    store: Option<SqliteStore>,
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
            if semantic_tools::is_semantic_tool(&invocation.callable) {
                semantic_tools::invoke(
                    &mut runtime,
                    &self.execution_id,
                    &self.allowed_tools,
                    invocation,
                )?
            } else {
                runtime.invoke_tool(&self.execution_id, &self.allowed_tools, invocation)?
            }
        };
        self.persist()?;
        Ok(result)
    }
}

struct SharedProviderHost {
    runtime: SharedRuntime,
    execution_id: ExecutionId,
    store: Option<SqliteStore>,
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

    fn record_workspace_checkpoint(
        &mut self,
        execution_id: &ExecutionId,
        workspace_id: WorkspaceId,
        files: BTreeMap<PathBuf, FileVersion>,
    ) -> Result<(), ConductorError> {
        self.record_domain_event(DomainEvent::WorkspaceCheckpointCaptured {
            execution_id: execution_id.clone(),
            workspace_id,
            files,
        })
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
    WorkspaceConsistency(WorkspaceConsistencyError),
    WorkspaceConsistencyNotInstalled,
    WorkspaceConsistencyUnavailable(WorkspaceId),
    WorkspaceLeaseStatePoisoned,
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
            Self::WorkspaceConsistency(error) => Display::fmt(error, f),
            Self::WorkspaceConsistencyNotInstalled => {
                f.write_str("workspace consistency is not installed")
            }
            Self::WorkspaceConsistencyUnavailable(workspace_id) => write!(
                f,
                "workspace consistency is not installed for writable workspace {workspace_id}"
            ),
            Self::WorkspaceLeaseStatePoisoned => f.write_str("workspace lease state lock poisoned"),
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

impl From<WorkspaceConsistencyError> for ServerError {
    fn from(value: WorkspaceConsistencyError) -> Self {
        Self::WorkspaceConsistency(value)
    }
}

impl From<WorkspaceLeaseError> for ServerError {
    fn from(_: WorkspaceLeaseError) -> Self {
        Self::WorkspaceLeaseStatePoisoned
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
        ConductorError::UnknownConfigRevision(id) => protocol_error(
            ErrorCode::UnknownId,
            format!("unknown configuration revision: {id}"),
        ),
        ConductorError::UnboundConfigRevision(id) => protocol_error(
            ErrorCode::InvalidRequest,
            format!("configuration revision is not bound in this process: {id}"),
        ),
        ConductorError::ConfigRevisionAlreadyBound(id) => protocol_error(
            ErrorCode::InvalidRequest,
            format!("configuration revision is already bound: {id}"),
        ),
        ConductorError::ConfigRevisionFingerprintMismatch {
            revision,
            expected,
            actual,
        } => protocol_error(
            ErrorCode::InvalidRequest,
            format!(
                "configuration revision fingerprint mismatch for {revision}: expected {expected}, found {actual}"
            ),
        ),
        ConductorError::IncompatibleSessionRebase {
            session_id,
            revision,
            reason,
        } => {
            let mut error = protocol_error(
                ErrorCode::InvalidRequest,
                format!(
                    "session {session_id} cannot rebase to configuration revision {revision}: {reason}"
                ),
            );
            error.session_id = Some(session_id);
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
        ConductorError::WorkspaceMismatch { expected, actual } => protocol_error(
            ErrorCode::InvalidRequest,
            format!("workspace binding mismatch: persisted {expected}, discovered {actual}"),
        ),
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
        ConductorError::InvalidFailureDecision {
            parent_execution,
            failed_child,
        } => {
            let mut error = protocol_error(
                ErrorCode::InvalidRequest,
                format!(
                    "invalid failure decision for child {failed_child} of orchestration {parent_execution}"
                ),
            );
            error.execution_id = Some(parent_execution);
            error
        }
        ConductorError::FailureDecisionDenied {
            parent_execution,
            decider_execution,
        } => {
            let mut error = protocol_error(
                ErrorCode::PolicyDenied,
                format!(
                    "execution {decider_execution} may not decide failures for orchestration {parent_execution}"
                ),
            );
            error.execution_id = Some(decider_execution);
            error
        }
        ConductorError::DelegationDenied {
            parent_execution,
            callable,
        } => {
            let mut error = protocol_error(
                ErrorCode::PolicyDenied,
                format!("execution {parent_execution} may not delegate callable {callable}"),
            );
            error.execution_id = Some(parent_execution);
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
        ConductorError::Context(error) => {
            protocol_error(ErrorCode::InvalidRequest, error.to_string())
        }
        ConductorError::Backend(error) => map_backend_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::{BackendExecutionRequest, BackendSessionRequest};
    use phenix_core::{
        AuthenticationState, CallableDescriptor, CallableKind, CallablePolicy, CapabilitySet,
        InferenceOptions, ModelDescriptor, ModelId, ModelTarget, OrchestrationDefinition,
        OrchestrationNode, OrchestrationNodeId, ProviderId,
    };
    use rusqlite::params;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Condvar};
    use std::time::Duration;

    struct CancelOnlySession {
        calls: Arc<AtomicUsize>,
    }

    struct ImmediateBackend;

    impl Backend for ImmediateBackend {
        fn capabilities(&self) -> phenix_backend::BackendCapabilities {
            phenix_backend::BackendCapabilities {
                tool_presentations: BTreeSet::new(),
                images: false,
                persistent_sessions: false,
            }
        }

        fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
            Ok(BackendCatalog {
                backend: BackendId::parse("fixture").unwrap(),
                models: vec![ModelDescriptor {
                    target: model_target(),
                    name: "Fixture".to_owned(),
                    selectable: true,
                }],
                authentication_state: AuthenticationState::NotRequired,
                authentication_methods: Vec::new(),
            })
        }

        fn open_session(
            &mut self,
            _request: BackendSessionRequest,
        ) -> Result<Arc<dyn BackendSession>, BackendError> {
            Ok(Arc::new(CancelOnlySession {
                calls: Arc::new(AtomicUsize::new(0)),
            }))
        }
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

    fn node(id: &str, callable: &str, dependencies: &[&str]) -> OrchestrationNode {
        OrchestrationNode {
            id: OrchestrationNodeId::parse(id).unwrap(),
            callable: CallableId::parse(callable).unwrap(),
            depends_on: dependencies
                .iter()
                .map(|dependency| OrchestrationNodeId::parse(*dependency).unwrap())
                .collect(),
            objective: None,
        }
    }

    fn job(execution: &str, session: &SessionId, group: &str) -> ExecutionJob {
        ExecutionJob {
            execution_id: ExecutionId::parse(execution).unwrap(),
            session_id: session.clone(),
            group_id: ExecutionId::parse(group).unwrap(),
        }
    }

    fn temporary_database() -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "phenix-conductor-multi-client-{}-{unique}.sqlite3",
            std::process::id()
        ))
    }

    fn connection_request(service: ConductorService, message: ClientMessage) -> Reply {
        let id = message.id;
        let (mut client, server) = UnixStream::pair().unwrap();
        let writer = server.try_clone().unwrap();
        let connection =
            thread::spawn(move || service.serve_connection(BufReader::new(server), writer));
        serde_json::to_writer(&mut client, &message).unwrap();
        client.write_all(b"\n").unwrap();
        client.flush().unwrap();

        let mut reader = BufReader::new(client.try_clone().unwrap());
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            match serde_json::from_str::<ServerMessage>(&line).unwrap() {
                ServerMessage::Response {
                    id: response_id,
                    response: ResponsePayload::Ok { result },
                } if response_id == id => {
                    drop(reader);
                    drop(client);
                    connection.join().unwrap().unwrap();
                    return result;
                }
                ServerMessage::Response {
                    id: response_id,
                    response: ResponsePayload::Error { error },
                } if response_id == id => panic!("request failed: {error:?}"),
                _ => {}
            }
        }
    }

    #[test]
    fn shared_service_routes_responses_per_connection_and_persists_ingress_order() {
        let database = temporary_database();
        let store = SqliteStore::new(&database);
        let workspace_id = WorkspaceId::parse("workspace:multi-client").unwrap();
        let mut runtime = ConductorRuntime::new();
        runtime.bind_workspace(workspace_id).unwrap();
        let session = runtime
            .create_session(
                None,
                Some("shared".to_owned()),
                ExecutionTarget::Fixed(model_target()),
            )
            .unwrap();
        let mut server = ConductorServer::new(runtime);
        server.store = Some(store.clone());
        server.persist().unwrap();
        server
            .register_backend(
                BackendId::parse("fixture").unwrap(),
                Box::new(ImmediateBackend),
            )
            .unwrap();
        let service = ConductorService::new(server).unwrap();

        let first_service = service.clone();
        let first_session = session.id.clone();
        let first = thread::spawn(move || {
            connection_request(
                first_service,
                ClientMessage {
                    id: 7,
                    command: Command::Submit {
                        session_id: first_session,
                        text: "first".to_owned(),
                    },
                },
            )
        });
        let second_service = service.clone();
        let second_session = session.id.clone();
        let second = thread::spawn(move || {
            connection_request(
                second_service,
                ClientMessage {
                    id: 7,
                    command: Command::Submit {
                        session_id: second_session,
                        text: "second".to_owned(),
                    },
                },
            )
        });
        let Reply::Execution { execution: first } = first.join().unwrap() else {
            panic!("first frontend received the wrong reply");
        };
        let Reply::Execution { execution: second } = second.join().unwrap() else {
            panic!("second frontend received the wrong reply");
        };
        assert_ne!(first.id, second.id);

        let connection = rusqlite::Connection::open(&database).unwrap();
        let accepted = connection
            .prepare(
                "SELECT execution_id FROM accepted_root_submissions
                 WHERE session_id = ?1 ORDER BY ingress_order",
            )
            .unwrap()
            .query_map(params![session.id.to_string()], |row| {
                row.get::<_, String>(0)
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(accepted.len(), 2);
        assert!(accepted.contains(&first.id.to_string()));
        assert!(accepted.contains(&second.id.to_string()));

        let cursor = service
            .inner
            .server
            .lock()
            .unwrap()
            .runtime()
            .events_since(0)[0]
            .sequence;
        let Reply::Initialized { events, .. } = connection_request(
            service.clone(),
            ClientMessage {
                id: 7,
                command: Command::Initialize {
                    after_sequence: Some(cursor),
                },
            },
        ) else {
            panic!("reconnecting frontend received the wrong reply");
        };
        assert!(!events.is_empty());
        assert!(events.iter().all(|event| event.sequence > cursor));
        assert_eq!(
            service
                .inner
                .server
                .lock()
                .unwrap()
                .runtime()
                .event_subscription_count(),
            0
        );

        drop(connection);
        drop(service);
        std::fs::remove_file(database).unwrap();
    }

    #[test]
    fn workspace_phase_checkpoints_only_the_first_writer_after_a_read_boundary() {
        let mut phase = WorkspacePhase::default();

        assert!(!phase.enter(WorkspaceLeaseMode::Read));
        assert!(phase.enter(WorkspaceLeaseMode::Write));
        assert!(!phase.enter(WorkspaceLeaseMode::Write));
        assert!(!phase.enter(WorkspaceLeaseMode::Read));
        assert!(phase.enter(WorkspaceLeaseMode::Write));
    }

    #[test]
    fn cancelling_root_reaches_active_descendant_scope_without_crossing_unrelated_execution() {
        let descendant_calls = Arc::new(AtomicUsize::new(0));
        let unrelated_calls = Arc::new(AtomicUsize::new(0));
        let mut runtime = ConductorRuntime::new();
        runtime
            .register_agent(phenix_core::AgentDefinition::new(
                descriptor("agent.child", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ))
            .unwrap();
        runtime
            .register_orchestration(OrchestrationDefinition {
                interface_agent: None,
                descriptor: descriptor("orchestration.tree", CallableKind::Orchestration),
                nodes: vec![OrchestrationNode {
                    id: OrchestrationNodeId::parse("child").unwrap(),
                    callable: CallableId::parse("agent.child").unwrap(),
                    depends_on: Vec::new(),
                    objective: Some("child".to_owned()),
                }],
            })
            .unwrap();

        let session = runtime
            .create_session(None, None, ExecutionTarget::Fixed(model_target()))
            .unwrap();
        let root = runtime.submit(&session.id, "root").unwrap();
        let orchestration = runtime
            .start_orchestration(
                &root.id,
                &CallableId::parse("orchestration.tree").unwrap(),
                "tree",
            )
            .unwrap();
        let child = runtime
            .snapshot()
            .executions
            .into_iter()
            .find(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
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
        for id in [&root.id, &orchestration.id, &child.id] {
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

    #[derive(Clone)]
    struct ConcurrentGate {
        state: Arc<(Mutex<usize>, Condvar)>,
    }

    struct ConcurrentBackend {
        gate: ConcurrentGate,
    }

    struct ConcurrentSession {
        gate: ConcurrentGate,
    }

    impl Backend for ConcurrentBackend {
        fn capabilities(&self) -> phenix_backend::BackendCapabilities {
            phenix_backend::BackendCapabilities {
                tool_presentations: BTreeSet::new(),
                images: false,
                persistent_sessions: false,
            }
        }

        fn open_session(
            &mut self,
            _request: BackendSessionRequest,
        ) -> Result<Arc<dyn BackendSession>, BackendError> {
            Ok(Arc::new(ConcurrentSession {
                gate: self.gate.clone(),
            }))
        }
    }

    impl BackendSession for ConcurrentSession {
        fn execute(
            &self,
            _request: BackendExecutionRequest,
            _host: &mut dyn BackendHost,
        ) -> Result<(), BackendError> {
            let (lock, ready) = &*self.gate.state;
            let mut active = lock.lock().unwrap();
            *active += 1;
            ready.notify_all();
            let (active, _) = ready
                .wait_timeout_while(active, Duration::from_secs(2), |active| *active < 2)
                .unwrap();
            if *active < 2 {
                return Err(BackendError::Transport(
                    "executions did not execute concurrently".to_owned(),
                ));
            }
            Ok(())
        }

        fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), BackendError> {
            Ok(())
        }
    }

    #[test]
    fn execution_queue_allows_one_group_to_fan_out_without_admitting_another_session_group() {
        let queue = ExecutionQueue::default();
        let first_session = SessionId::parse("session-1").unwrap();
        let second_session = SessionId::parse("session-2").unwrap();
        queue
            .enqueue(job("execution-1", &first_session, "group-1"))
            .unwrap();
        queue
            .enqueue(job("execution-2", &first_session, "group-1"))
            .unwrap();
        queue
            .enqueue(job("execution-3", &first_session, "group-2"))
            .unwrap();
        queue
            .enqueue(job("execution-4", &second_session, "group-3"))
            .unwrap();

        let first = queue.next().unwrap().unwrap();
        assert_eq!(
            first.execution_id,
            ExecutionId::parse("execution-1").unwrap()
        );
        let sibling = queue.next().unwrap().unwrap();
        assert_eq!(
            sibling.execution_id,
            ExecutionId::parse("execution-2").unwrap()
        );
        let independent = queue.next().unwrap().unwrap();
        assert_eq!(
            independent.execution_id,
            ExecutionId::parse("execution-4").unwrap()
        );

        assert!(!queue.complete(&first, false).unwrap());
        assert!(queue.complete(&sibling, true).unwrap());
        let next_group = queue.next().unwrap().unwrap();
        assert_eq!(
            next_group.execution_id,
            ExecutionId::parse("execution-3").unwrap()
        );

        assert!(queue.complete(&next_group, true).unwrap());
        assert!(queue.complete(&independent, true).unwrap());
        queue.close().unwrap();
        assert!(queue.next().unwrap().is_none());
    }

    #[test]
    fn closed_queue_waits_for_active_group_and_accepts_generated_descendants() {
        let queue = ExecutionQueue::default();
        let session = SessionId::parse("session-1").unwrap();
        queue
            .enqueue(job("execution-1", &session, "group-1"))
            .unwrap();
        let active = queue.next().unwrap().unwrap();
        queue.close().unwrap();

        let waiter = queue.clone();
        let (sender, receiver) = mpsc::channel();
        let thread = std::thread::spawn(move || sender.send(waiter.next().unwrap()).unwrap());
        assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());

        queue
            .enqueue(job("execution-2", &session, "group-1"))
            .unwrap();
        let generated = receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(
            generated.execution_id,
            ExecutionId::parse("execution-2").unwrap()
        );

        assert!(!queue.complete(&active, false).unwrap());
        assert!(queue.complete(&generated, true).unwrap());
        thread.join().unwrap();
        assert!(queue.next().unwrap().is_none());
    }

    #[test]
    fn read_only_sessions_share_workspace_and_execute_concurrently() {
        let gate = ConcurrentGate {
            state: Arc::new((Mutex::new(0), Condvar::new())),
        };
        let mut server = ConductorServer::new(ConductorRuntime::new());
        server
            .register_backend(
                BackendId::parse("fixture").unwrap(),
                Box::new(ConcurrentBackend { gate }),
            )
            .unwrap();
        let target = serde_json::to_string(&ExecutionTarget::Fixed(model_target())).unwrap();
        let input = format!(
            "{{\"id\":1,\"command\":{{\"type\":\"create_session\",\"parent_session\":null,\"name\":\"a\",\"target\":{target}}}}}\n\\
             {{\"id\":2,\"command\":{{\"type\":\"create_session\",\"parent_session\":null,\"name\":\"b\",\"target\":{target}}}}}\n\\
             {{\"id\":3,\"command\":{{\"type\":\"submit\",\"session_id\":\"session-1\",\"text\":\"one\"}}}}\n\\
             {{\"id\":4,\"command\":{{\"type\":\"submit\",\"session_id\":\"session-2\",\"text\":\"two\"}}}}\n"
        );
        server
            .serve_ndjson(std::io::Cursor::new(input), std::io::sink())
            .unwrap();
        let executions = server.runtime().snapshot().executions;
        assert_eq!(executions.len(), 2);
        assert!(
            executions
                .iter()
                .all(|execution| execution.state == ExecutionState::Completed),
            "independent execution states: {executions:?}"
        );
    }

    #[test]
    fn ready_dag_siblings_share_workers_and_generated_join_runs_after_input_eof() {
        let gate = ConcurrentGate {
            state: Arc::new((Mutex::new(0), Condvar::new())),
        };
        let mut runtime = ConductorRuntime::new();
        for callable in ["agent.alpha", "agent.beta", "agent.join"] {
            runtime
                .register_agent(phenix_core::AgentDefinition::new(
                    descriptor(callable, CallableKind::Agent),
                    phenix_core::ExecutionAuthority::read_only(),
                ))
                .unwrap();
        }
        runtime
            .register_orchestration(OrchestrationDefinition {
                interface_agent: None,
                descriptor: descriptor("orchestration.parallel", CallableKind::Orchestration),
                nodes: vec![
                    node("alpha", "agent.alpha", &[]),
                    node("beta", "agent.beta", &[]),
                    node("join", "agent.join", &["alpha", "beta"]),
                ],
            })
            .unwrap();

        let mut server = ConductorServer::new(runtime);
        server
            .register_backend(
                BackendId::parse("fixture").unwrap(),
                Box::new(ConcurrentBackend { gate }),
            )
            .unwrap();
        let target = serde_json::to_string(&ExecutionTarget::Fixed(model_target())).unwrap();
        let input = format!(
            "{{\"id\":1,\"command\":{{\"type\":\"create_session\",\"parent_session\":null,\"name\":\"dag\",\"target\":{target}}}}}\n\\
             {{\"id\":2,\"command\":{{\"type\":\"start_callable\",\"session_id\":\"session-1\",\"callable\":\"orchestration.parallel\",\"objective\":\"run\"}}}}\n"
        );
        server
            .serve_ndjson(std::io::Cursor::new(input), std::io::sink())
            .unwrap();

        let executions = server.runtime().snapshot().executions;
        assert_eq!(executions.len(), 4);
        assert!(
            executions
                .iter()
                .all(|execution| execution.state == ExecutionState::Completed),
            "DAG execution states: {executions:?}"
        );
    }
}
