#![forbid(unsafe_code)]

mod mcp_bridge;

use agent_client_protocol::schema::v1::{
    AuthMethod, AuthenticateRequest, CancelNotification, ConnectMcpRequest, ContentBlock,
    ContentChunk, DisconnectMcpRequest, ErrorCode, InitializeRequest, MessageMcpNotification,
    MessageMcpRequest, NewSessionRequest, PromptRequest, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TextContent,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::{AcpAgent, AcpAgentConfig, Agent, ConnectionTo};
use mcp_bridge::{BridgeToolRequest, ToolBridge};
use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, PreparedToolSurface, ToolPresentation,
};
use phenix_core::{
    AuthenticationMethodDescriptor, AuthenticationMethodId, AuthenticationMethodKind,
    AuthenticationState, BackendCatalog, BackendId, InferenceEffort, InferenceOptions,
    ModelDescriptor, ModelId, ModelTarget, ProviderId, SessionId,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{mpsc, Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpBackendConfig {
    pub backend: BackendId,
    pub provider: ProviderId,
    pub command: PathBuf,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: PathBuf,
}

impl AcpBackendConfig {
    #[must_use]
    pub fn new(
        backend: BackendId,
        provider: ProviderId,
        command: impl Into<PathBuf>,
        cwd: impl Into<PathBuf>,
    ) -> Self {
        Self {
            backend,
            provider,
            command: command.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: cwd.into(),
        }
    }

    #[must_use]
    pub fn args(mut self, args: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    #[must_use]
    pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(name.into(), value.into());
        self
    }
}

#[derive(Clone)]
pub struct AcpBackend {
    config: AcpBackendConfig,
    persistent_sessions: BTreeMap<SessionId, Arc<AcpPersistentSession>>,
}

impl AcpBackend {
    #[must_use]
    pub fn new(config: AcpBackendConfig) -> Self {
        Self {
            config,
            persistent_sessions: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn config(&self) -> &AcpBackendConfig {
        &self.config
    }

    fn validate_session_request(
        &self,
        request: &BackendSessionRequest,
    ) -> Result<(), BackendError> {
        if request.model.backend != self.config.backend {
            return Err(BackendError::Unsupported(format!(
                "ACP backend {} cannot serve target backend {}",
                self.config.backend, request.model.backend
            )));
        }
        if request.model.provider != self.config.provider {
            return Err(BackendError::Unsupported(format!(
                "ACP backend provider {} cannot serve target provider {}",
                self.config.provider, request.model.provider
            )));
        }
        if request.model.inference.effort.is_some() {
            return Err(BackendError::Unsupported(
                "ACP inference effort mapping is not implemented in R7".to_owned(),
            ));
        }
        if !request.tools.is_empty()
            && request.tools.presentation() != Some(ToolPresentation::AcpExtension)
        {
            return Err(BackendError::Unsupported(
                "ACP conductor tools require the negotiated ACP extension presentation".to_owned(),
            ));
        }
        Ok(())
    }
}

impl Backend for AcpBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::AcpExtension]),
            images: false,
            persistent_sessions: true,
        }
    }

    fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
        block_on(discover_catalog(self.config.clone()))
    }

    fn authenticate(&mut self, method: &AuthenticationMethodId) -> Result<(), BackendError> {
        let catalog = self.catalog()?;
        let descriptor = catalog
            .authentication_methods
            .iter()
            .find(|candidate| candidate.id == *method)
            .ok_or_else(|| {
                BackendError::Unsupported(format!(
                    "ACP agent does not advertise authentication method {method}"
                ))
            })?;
        if !descriptor.selectable {
            return Err(BackendError::Unsupported(format!(
                "ACP authentication method {method} requires a frontend credential/terminal flow"
            )));
        }
        block_on(authenticate_agent(self.config.clone(), method.clone()))
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        self.validate_session_request(&request)?;
        Ok(Arc::new(AcpBackendSession {
            config: self.config.clone(),
            model: request.model,
            tools: request.tools,
            cancellation: Mutex::new(CancellationState::default()),
        }))
    }

    fn open_persistent_session(
        &mut self,
        session_id: &SessionId,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        self.validate_session_request(&request)?;
        if let Some(session) = self.persistent_sessions.get(session_id) {
            session.set_request(request.model, request.tools)?;
            return Ok(session.clone());
        }

        let session = Arc::new(AcpPersistentSession::start(
            self.config.clone(),
            request.model,
            request.tools,
        )?);
        self.persistent_sessions
            .insert(session_id.clone(), session.clone());
        Ok(session)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CancellationSignal {
    Cancel,
    Complete,
}

#[derive(Debug)]
struct ArmedCancellation {
    receiver: mpsc::Receiver<CancellationSignal>,
    completion: mpsc::Sender<CancellationSignal>,
}

#[derive(Debug, Default)]
struct CancellationState {
    requested: bool,
    signal: Option<mpsc::Sender<CancellationSignal>>,
}

fn arm_cancellation(
    cancellation: &Mutex<CancellationState>,
) -> Result<Option<ArmedCancellation>, BackendError> {
    let mut cancellation = cancellation
        .lock()
        .map_err(|_| BackendError::Protocol("ACP cancellation state lock poisoned".to_owned()))?;
    if cancellation.signal.is_some() {
        return Err(BackendError::Protocol(
            "ACP backend session is already executing".to_owned(),
        ));
    }
    if std::mem::take(&mut cancellation.requested) {
        return Ok(None);
    }
    let (signal, receiver) = mpsc::channel();
    cancellation.signal = Some(signal.clone());
    Ok(Some(ArmedCancellation {
        receiver,
        completion: signal,
    }))
}

fn disarm_cancellation(cancellation: &Mutex<CancellationState>) -> Result<(), BackendError> {
    let mut cancellation = cancellation
        .lock()
        .map_err(|_| BackendError::Protocol("ACP cancellation state lock poisoned".to_owned()))?;
    cancellation.signal = None;
    cancellation.requested = false;
    Ok(())
}

fn request_cancellation(cancellation: &Mutex<CancellationState>) -> Result<(), BackendError> {
    let mut cancellation = cancellation
        .lock()
        .map_err(|_| BackendError::Protocol("ACP cancellation state lock poisoned".to_owned()))?;
    cancellation.requested = true;
    if let Some(signal) = cancellation.signal.as_ref() {
        let _ = signal.send(CancellationSignal::Cancel);
    }
    Ok(())
}

#[derive(Debug)]
struct AcpBackendSession {
    config: AcpBackendConfig,
    model: ModelTarget,
    tools: PreparedToolSurface,
    cancellation: Mutex<CancellationState>,
}

impl AcpBackendSession {
    fn arm_cancellation(&self) -> Result<Option<ArmedCancellation>, BackendError> {
        arm_cancellation(&self.cancellation)
    }

    fn disarm_cancellation(&self) -> Result<(), BackendError> {
        disarm_cancellation(&self.cancellation)
    }
}

impl BackendSession for AcpBackendSession {
    fn execute(
        &self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        let Some(cancellation) = self.arm_cancellation()? else {
            return Ok(());
        };
        let config = self.config.clone();
        let model = self.model.clone();
        let tools = self.tools.clone();
        let prompt = request.prompt;
        let (tx, rx) = mpsc::channel();

        let result = thread::scope(|scope| {
            let worker_tx = tx.clone();
            scope.spawn(move || {
                let done_tx = worker_tx.clone();
                let result = block_on(run_turn(
                    config,
                    model,
                    tools,
                    prompt,
                    worker_tx,
                    cancellation,
                ));
                let _ = done_tx.send(WorkerMessage::Done(result));
            });
            drop(tx);

            receive_worker_messages(rx, host)
        });
        self.disarm_cancellation()?;
        result
    }

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        request_cancellation(&self.cancellation)
    }
}

struct AcpPersistentSession {
    model: Mutex<ModelTarget>,
    tools: Mutex<PreparedToolSurface>,
    bridge_available: bool,
    commands: mpsc::Sender<PersistentCommand>,
    cancellation: Mutex<CancellationState>,
}

impl AcpPersistentSession {
    fn start(
        config: AcpBackendConfig,
        model: ModelTarget,
        tools: PreparedToolSurface,
    ) -> Result<Self, BackendError> {
        let (commands, command_rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker_model = model.clone();
        let worker_tools = tools.clone();
        thread::spawn(move || {
            let ready_error = ready_tx.clone();
            if let Err(error) = block_on(run_persistent_session(
                config,
                worker_model,
                worker_tools,
                command_rx,
                ready_tx,
            )) {
                let _ = ready_error.send(Err(error));
            }
        });
        let bridge_available = ready_rx.recv().map_err(|error| {
            BackendError::Transport(format!(
                "ACP persistent session worker closed during startup: {error}"
            ))
        })??;
        Ok(Self {
            model: Mutex::new(model),
            tools: Mutex::new(tools),
            bridge_available,
            commands,
            cancellation: Mutex::new(CancellationState::default()),
        })
    }

    fn set_request(
        &self,
        model: ModelTarget,
        tools: PreparedToolSurface,
    ) -> Result<(), BackendError> {
        if !tools.is_empty() && !self.bridge_available {
            return Err(BackendError::Unsupported(
                "ACP agent does not advertise native MCP-over-ACP support for this persistent session"
                    .to_owned(),
            ));
        }
        *self.model.lock().map_err(|_| {
            BackendError::Protocol("ACP persistent model lock poisoned".to_owned())
        })? = model;
        *self.tools.lock().map_err(|_| {
            BackendError::Protocol("ACP persistent tool surface lock poisoned".to_owned())
        })? = tools;
        Ok(())
    }
}

impl BackendSession for AcpPersistentSession {
    fn execute(
        &self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        let Some(cancellation) = arm_cancellation(&self.cancellation)? else {
            return Ok(());
        };
        let model = self
            .model
            .lock()
            .map_err(|_| BackendError::Protocol("ACP persistent model lock poisoned".to_owned()))?
            .clone();
        let tools = self
            .tools
            .lock()
            .map_err(|_| {
                BackendError::Protocol("ACP persistent tool surface lock poisoned".to_owned())
            })?
            .clone();
        let (events, event_rx) = mpsc::channel();
        let send_result = self.commands.send(PersistentCommand {
            model,
            tools,
            prompt: request.prompt,
            events,
            cancellation,
        });
        let result = match send_result {
            Ok(()) => receive_worker_messages(event_rx, host),
            Err(error) => Err(BackendError::Transport(format!(
                "ACP persistent session worker is unavailable: {error}"
            ))),
        };
        disarm_cancellation(&self.cancellation)?;
        result
    }

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        request_cancellation(&self.cancellation)
    }
}

struct PersistentCommand {
    model: ModelTarget,
    tools: PreparedToolSurface,
    prompt: String,
    events: mpsc::Sender<WorkerMessage>,
    cancellation: ArmedCancellation,
}

impl PersistentCommand {
    const fn into_execute(self) -> Self {
        self
    }
}

#[derive(Debug)]
enum WorkerMessage {
    Event(BackendEvent),
    ToolCall(BridgeToolRequest),
    Done(Result<(), BackendError>),
}

fn receive_worker_messages(
    rx: mpsc::Receiver<WorkerMessage>,
    host: &mut dyn BackendHost,
) -> Result<(), BackendError> {
    let mut host_error = None;
    loop {
        match rx.recv() {
            Ok(WorkerMessage::Event(event)) => {
                if host_error.is_none() {
                    host_error = host.emit(event).err();
                }
            }
            Ok(WorkerMessage::ToolCall(request)) => {
                let result = if let Some(error) = host_error.as_ref() {
                    Err(BackendError::Protocol(format!(
                        "backend host already failed before tool invocation: {error}"
                    )))
                } else {
                    host.invoke_tool(request.invocation)
                };
                let _ = request.response.send(result);
            }
            Ok(WorkerMessage::Done(result)) => return host_error.map_or(result, Err),
            Err(error) => {
                return Err(host_error.unwrap_or_else(|| {
                    BackendError::Transport(format!(
                        "ACP worker channel closed before completion: {error}"
                    ))
                }));
            }
        }
    }
}

async fn discover_catalog(config: AcpBackendConfig) -> Result<BackendCatalog, BackendError> {
    let backend = config.backend.clone();
    let provider = config.provider.clone();
    let cwd = config.cwd.clone();
    let agent = new_agent(&config);

    agent_client_protocol::Client
        .builder()
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            let initialized = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let authentication_methods =
                normalize_auth_methods(&initialized.auth_methods, &backend, &provider)
                    .map_err(to_acp_error)?;

            match connection
                .send_request(NewSessionRequest::new(cwd))
                .block_task()
                .await
            {
                Ok(session) => {
                    let options = serde_json::to_value(&session.config_options)
                        .map_err(agent_client_protocol::Error::into_internal_error)?;
                    let models =
                        model_descriptors(&options, &backend, &provider).map_err(to_acp_error)?;
                    Ok(BackendCatalog {
                        backend,
                        models,
                        authentication_state: if authentication_methods.is_empty() {
                            AuthenticationState::NotRequired
                        } else {
                            AuthenticationState::Authenticated
                        },
                        authentication_methods,
                    })
                }
                Err(error) if error.code == ErrorCode::AuthRequired => Ok(BackendCatalog {
                    backend,
                    models: Vec::new(),
                    authentication_state: AuthenticationState::Required,
                    authentication_methods,
                }),
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))
}

async fn authenticate_agent(
    config: AcpBackendConfig,
    method: AuthenticationMethodId,
) -> Result<(), BackendError> {
    let agent = new_agent(&config);
    agent_client_protocol::Client
        .builder()
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            let initialized = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let advertised = initialized
                .auth_methods
                .iter()
                .find(|candidate| candidate.id().0.as_ref() == method.as_str())
                .ok_or_else(|| {
                    agent_client_protocol::Error::invalid_params()
                        .data(format!("unknown authentication method {method}"))
                })?;
            if !matches!(advertised, AuthMethod::Agent(_)) {
                return Err(agent_client_protocol::Error::invalid_params().data(format!(
                    "authentication method {method} requires client-provided credentials or terminal"
                )));
            }
            connection
                .send_request(AuthenticateRequest::new(method.as_str().to_owned()))
                .block_task()
                .await?;
            Ok(())
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))
}

async fn run_turn(
    config: AcpBackendConfig,
    model: ModelTarget,
    tools: PreparedToolSurface,
    prompt: String,
    events: mpsc::Sender<WorkerMessage>,
    cancellation: ArmedCancellation,
) -> Result<(), BackendError> {
    let agent = new_agent(&config);
    let notification_events = events.clone();
    let bridge = ToolBridge::default();
    let connect_bridge = bridge.clone();
    let message_bridge = bridge.clone();
    let notification_bridge = bridge.clone();
    let disconnect_bridge = bridge.clone();

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                if let Some(event) = normalize_update(notification.update) {
                    let _ = notification_events.send(WorkerMessage::Event(event));
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_notification(
            async move |notification: MessageMcpNotification, _connection| {
                notification_bridge.notification(notification)
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |_request: RequestPermissionRequest, responder, _connection| {
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ConnectMcpRequest, responder, _connection| {
                responder.respond(connect_bridge.connect(request)?)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: MessageMcpRequest, responder, _connection| {
                responder.respond(message_bridge.message(request)?)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: DisconnectMcpRequest, responder, _connection| {
                responder.respond(disconnect_bridge.disconnect(request)?)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, |connection: ConnectionTo<Agent>| async move {
            let initialized = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            if !tools.is_empty() && !initialized.agent_capabilities.mcp_capabilities.acp {
                return Err(to_acp_error(BackendError::Unsupported(
                    "ACP agent does not advertise native MCP-over-ACP support".to_owned(),
                )));
            }

            let mut new_session = NewSessionRequest::new(config.cwd);
            if !tools.is_empty() {
                bridge.provision(&tools).map_err(to_acp_error)?;
                new_session = new_session.mcp_servers(vec![bridge.server()]);
            }
            let session = connection.send_request(new_session).block_task().await?;
            let session_id = session.session_id.clone();
            let config_options = serde_json::to_value(&session.config_options)
                .map_err(agent_client_protocol::Error::into_internal_error)?;
            let selection = exact_model_selection(&config_options, model.model.as_str())
                .map_err(to_acp_error)?;
            if selection.current_value.as_deref() != Some(model.model.as_str()) {
                connection
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        selection.config_id,
                        model.model.as_str(),
                    ))
                    .block_task()
                    .await?;
            }

            if !tools.is_empty() {
                bridge
                    .bind_execution(&tools, events.clone())
                    .map_err(to_acp_error)?;
            }
            let cancel_forwarder =
                spawn_cancel_forwarder(connection.clone(), session_id.clone(), cancellation);
            let prompt_result = connection
                .send_request(PromptRequest::new(
                    session_id,
                    vec![ContentBlock::Text(TextContent::new(prompt))],
                ))
                .block_task()
                .await;
            bridge.unbind_execution();
            drop(cancel_forwarder);
            prompt_result?;
            Ok(())
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))?;

    Ok(())
}

async fn run_persistent_session(
    config: AcpBackendConfig,
    initial_model: ModelTarget,
    initial_tools: PreparedToolSurface,
    commands: mpsc::Receiver<PersistentCommand>,
    ready: mpsc::SyncSender<Result<bool, BackendError>>,
) -> Result<(), BackendError> {
    let agent = new_agent(&config);
    let active_events = Arc::new(Mutex::new(None::<mpsc::Sender<WorkerMessage>>));
    let notification_events = active_events.clone();
    let bridge = ToolBridge::default();
    let connect_bridge = bridge.clone();
    let message_bridge = bridge.clone();
    let notification_bridge = bridge.clone();
    let disconnect_bridge = bridge.clone();

    agent_client_protocol::Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _connection| {
                if let Some(event) = normalize_update(notification.update) {
                    if let Ok(events) = notification_events.lock() {
                        if let Some(events) = events.as_ref() {
                            let _ = events.send(WorkerMessage::Event(event));
                        }
                    }
                }
                Ok(())
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_notification(
            async move |notification: MessageMcpNotification, _connection| {
                notification_bridge.notification(notification)
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .on_receive_request(
            async move |_request: RequestPermissionRequest, responder, _connection| {
                responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ConnectMcpRequest, responder, _connection| {
                responder.respond(connect_bridge.connect(request)?)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: MessageMcpRequest, responder, _connection| {
                responder.respond(message_bridge.message(request)?)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: DisconnectMcpRequest, responder, _connection| {
                responder.respond(disconnect_bridge.disconnect(request)?)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .connect_with(agent, move |connection: ConnectionTo<Agent>| async move {
            let initialized = connection
                .send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let bridge_available = initialized.agent_capabilities.mcp_capabilities.acp;
            if !initial_tools.is_empty() && !bridge_available {
                return Err(to_acp_error(BackendError::Unsupported(
                    "ACP agent does not advertise native MCP-over-ACP support".to_owned(),
                )));
            }

            let mut new_session = NewSessionRequest::new(config.cwd);
            if bridge_available {
                bridge.provision(&initial_tools).map_err(to_acp_error)?;
                new_session = new_session.mcp_servers(vec![bridge.server()]);
            }
            let session = connection.send_request(new_session).block_task().await?;
            let session_id = session.session_id.clone();
            let config_options = serde_json::to_value(&session.config_options)
                .map_err(agent_client_protocol::Error::into_internal_error)?;
            let initial_selection =
                exact_model_selection(&config_options, initial_model.model.as_str())
                    .map_err(to_acp_error)?;
            let model_config_id = initial_selection.config_id;
            let mut current_model = initial_selection.current_value;
            if current_model.as_deref() != Some(initial_model.model.as_str()) {
                connection
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        model_config_id.clone(),
                        initial_model.model.as_str(),
                    ))
                    .block_task()
                    .await?;
                current_model = Some(initial_model.model.as_str().to_owned());
            }
            ready.send(Ok(bridge_available)).map_err(|error| {
                agent_client_protocol::Error::internal_error()
                    .data(format!("persistent ACP startup receiver closed: {error}"))
            })?;

            while let Ok(command) = commands.recv() {
                let command = command.into_execute();
                let validation =
                    exact_model_selection(&config_options, command.model.model.as_str())
                        .map_err(to_acp_error);
                if let Err(error) = validation {
                    let message = error.to_string();
                    let _ =
                        command
                            .events
                            .send(WorkerMessage::Done(Err(BackendError::Unsupported(
                                message.clone(),
                            ))));
                    return Err(error);
                }
                if !command.tools.is_empty() && !bridge_available {
                    let _ =
                        command
                            .events
                            .send(WorkerMessage::Done(Err(BackendError::Unsupported(
                                "ACP agent does not advertise native MCP-over-ACP support"
                                    .to_owned(),
                            ))));
                    continue;
                }
                if current_model.as_deref() != Some(command.model.model.as_str()) {
                    if let Err(error) = connection
                        .send_request(SetSessionConfigOptionRequest::new(
                            session_id.clone(),
                            model_config_id.clone(),
                            command.model.model.as_str(),
                        ))
                        .block_task()
                        .await
                    {
                        let message = error.to_string();
                        let _ = command
                            .events
                            .send(WorkerMessage::Done(Err(BackendError::Transport(message))));
                        return Err(error);
                    }
                    current_model = Some(command.model.model.as_str().to_owned());
                }

                {
                    let mut active = active_events.lock().map_err(|_| {
                        agent_client_protocol::Error::internal_error()
                            .data("persistent ACP event sink lock poisoned")
                    })?;
                    *active = Some(command.events.clone());
                }
                if bridge_available {
                    if let Err(error) =
                        bridge.bind_execution(&command.tools, command.events.clone())
                    {
                        if let Ok(mut active) = active_events.lock() {
                            *active = None;
                        }
                        let message = error.to_string();
                        let _ = command.events.send(WorkerMessage::Done(Err(error)));
                        return Err(agent_client_protocol::Error::internal_error().data(message));
                    }
                }
                let cancel_forwarder = spawn_cancel_forwarder(
                    connection.clone(),
                    session_id.clone(),
                    command.cancellation,
                );
                let prompt_result = connection
                    .send_request(PromptRequest::new(
                        session_id.clone(),
                        vec![ContentBlock::Text(TextContent::new(command.prompt))],
                    ))
                    .block_task()
                    .await;
                bridge.unbind_execution();
                drop(cancel_forwarder);
                if let Ok(mut active) = active_events.lock() {
                    *active = None;
                }
                match prompt_result {
                    Ok(_) => {
                        let _ = command.events.send(WorkerMessage::Done(Ok(())));
                    }
                    Err(error) => {
                        let message = error.to_string();
                        let _ = command
                            .events
                            .send(WorkerMessage::Done(Err(BackendError::Transport(message))));
                        return Err(error);
                    }
                }
            }
            Ok(())
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))
}

struct CancelForwarder {
    completion: mpsc::Sender<CancellationSignal>,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for CancelForwarder {
    fn drop(&mut self) {
        let _ = self.completion.send(CancellationSignal::Complete);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn spawn_cancel_forwarder(
    connection: ConnectionTo<Agent>,
    session_id: agent_client_protocol::schema::v1::SessionId,
    cancellation: ArmedCancellation,
) -> CancelForwarder {
    let ArmedCancellation {
        receiver,
        completion,
    } = cancellation;
    let thread = thread::spawn(move || {
        if matches!(receiver.recv(), Ok(CancellationSignal::Cancel)) {
            let _ = connection.send_notification(CancelNotification::new(session_id));
        }
    });
    CancelForwarder {
        completion,
        thread: Some(thread),
    }
}

fn new_agent(config: &AcpBackendConfig) -> AcpAgent {
    AcpAgent::new(
        AcpAgentConfig::new(config.command.clone())
            .args(config.args.clone())
            .envs(config.env.clone()),
    )
}

fn to_acp_error(error: BackendError) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(error.to_string())
}

fn normalize_auth_methods(
    methods: &[AuthMethod],
    backend: &BackendId,
    provider: &ProviderId,
) -> Result<Vec<AuthenticationMethodDescriptor>, BackendError> {
    methods
        .iter()
        .map(|method| {
            let (kind, selectable) = match method {
                AuthMethod::Agent(_) => (AuthenticationMethodKind::Agent, true),
                AuthMethod::EnvVar(_) => (AuthenticationMethodKind::Environment, false),
                AuthMethod::Terminal(_) => (AuthenticationMethodKind::Terminal, false),
                _ => (AuthenticationMethodKind::Agent, false),
            };
            Ok(AuthenticationMethodDescriptor {
                id: AuthenticationMethodId::parse(method.id().0.to_string()).map_err(|_| {
                    BackendError::Protocol(
                        "ACP advertised an empty authentication method id".into(),
                    )
                })?,
                backend: backend.clone(),
                provider: provider.clone(),
                kind,
                name: method.name().to_owned(),
                description: method.description().map(ToOwned::to_owned),
                selectable,
            })
        })
        .collect()
}

fn model_descriptors(
    serialized_config_options: &Value,
    backend: &BackendId,
    provider: &ProviderId,
) -> Result<Vec<ModelDescriptor>, BackendError> {
    let model_option = find_model_option(serialized_config_options)?;
    let select_options = model_option.get("options").ok_or_else(|| {
        BackendError::Protocol("ACP model config is not a select option".to_owned())
    })?;
    let mut values = Vec::new();
    collect_select_values(select_options, &mut values);
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|(value, _)| seen.insert(value.clone()))
        .map(|(value, name)| {
            let model = ModelId::parse(value).map_err(|_| {
                BackendError::Protocol("ACP advertised an empty model value id".to_owned())
            })?;
            Ok(ModelDescriptor {
                target: ModelTarget {
                    backend: backend.clone(),
                    provider: provider.clone(),
                    model,
                    inference: InferenceOptions::default(),
                },
                name,
                selectable: true,
            })
        })
        .collect()
}

fn find_model_option(serialized_config_options: &Value) -> Result<&Value, BackendError> {
    let options = serialized_config_options.as_array().ok_or_else(|| {
        BackendError::Protocol(
            "ACP session config options did not serialize as an array".to_owned(),
        )
    })?;
    options
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))
        .ok_or_else(|| {
            BackendError::Unsupported(
                "ACP agent did not advertise a model configuration option".to_owned(),
            )
        })
}

fn collect_select_values(value: &Value, output: &mut Vec<(String, String)>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_select_values(value, output);
            }
        }
        Value::Object(object) => {
            if let Some(value) = object.get("value").and_then(Value::as_str) {
                let name = object.get("name").and_then(Value::as_str).unwrap_or(value);
                output.push((value.to_owned(), name.to_owned()));
            }
            if let Some(options) = object.get("options") {
                collect_select_values(options, output);
            }
        }
        _ => {}
    }
}

fn normalize_update(update: SessionUpdate) -> Option<BackendEvent> {
    match update {
        SessionUpdate::AgentMessageChunk(ContentChunk {
            content: ContentBlock::Text(text),
            ..
        }) => Some(BackendEvent::ContentDelta(text.text)),
        SessionUpdate::AgentThoughtChunk(ContentChunk {
            content: ContentBlock::Text(text),
            ..
        }) => Some(BackendEvent::ReasoningDelta(text.text)),
        _ => None,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ModelSelection {
    config_id: String,
    current_value: Option<String>,
}

fn exact_model_selection(
    serialized_config_options: &Value,
    desired_model: &str,
) -> Result<ModelSelection, BackendError> {
    let model_option = find_model_option(serialized_config_options)?;
    let config_id = model_option
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| BackendError::Protocol("ACP model config is missing its id".to_owned()))?;
    let select_options = model_option.get("options").ok_or_else(|| {
        BackendError::Protocol("ACP model config is not a select option".to_owned())
    })?;
    if !contains_select_value(select_options, desired_model) {
        return Err(BackendError::Unsupported(format!(
            "ACP agent does not advertise exact model value {desired_model}"
        )));
    }
    Ok(ModelSelection {
        config_id: config_id.to_owned(),
        current_value: model_option
            .get("currentValue")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

fn contains_select_value(value: &Value, desired: &str) -> bool {
    match value {
        Value::Array(values) => values
            .iter()
            .any(|value| contains_select_value(value, desired)),
        Value::Object(object) => {
            object.get("value").and_then(Value::as_str) == Some(desired)
                || object
                    .get("options")
                    .is_some_and(|value| contains_select_value(value, desired))
        }
        _ => false,
    }
}

struct ThreadWake(thread::Thread);

impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Waker::from(Arc::new(ThreadWake(thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future: Pin<Box<F>> = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => return output,
            Poll::Pending => thread::park(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::ToolProvision;
    use serde_json::json;

    fn config() -> AcpBackendConfig {
        AcpBackendConfig::new(
            BackendId::parse("pi-acp").unwrap(),
            ProviderId::parse("openai").unwrap(),
            "pi-acp",
            ".",
        )
    }

    fn model() -> ModelTarget {
        ModelTarget {
            backend: BackendId::parse("pi-acp").unwrap(),
            provider: ProviderId::parse("openai").unwrap(),
            model: ModelId::parse("gpt-5.6-sol").unwrap(),
            inference: InferenceOptions::default(),
        }
    }

    fn empty_tools() -> PreparedToolSurface {
        ToolProvision::default()
            .prepare(&AcpBackend::new(config()).capabilities())
            .unwrap()
    }

    fn backend_session() -> AcpBackendSession {
        AcpBackendSession {
            config: config(),
            model: model(),
            tools: empty_tools(),
            cancellation: Mutex::new(CancellationState::default()),
        }
    }

    #[test]
    fn cancel_before_execute_is_latched() {
        let session = backend_session();
        let execution = phenix_core::ExecutionId::parse("execution-1").unwrap();
        session.cancel(&execution).unwrap();
        assert!(session.arm_cancellation().unwrap().is_none());
        assert!(session.arm_cancellation().unwrap().is_some());
        session.disarm_cancellation().unwrap();
    }

    #[test]
    fn cancel_signals_active_execution() {
        let session = backend_session();
        let execution = phenix_core::ExecutionId::parse("execution-1").unwrap();
        let cancellation = session.arm_cancellation().unwrap().unwrap();
        session.cancel(&execution).unwrap();
        assert_eq!(cancellation.receiver.recv(), Ok(CancellationSignal::Cancel));
        session.disarm_cancellation().unwrap();
        assert!(session.arm_cancellation().unwrap().is_some());
        session.disarm_cancellation().unwrap();
    }

    #[test]
    fn exact_model_selection_uses_value_id_not_display_name() {
        let options = json!([{
            "id": "model",
            "category": "model",
            "type": "select",
            "currentValue": "other",
            "options": [
                {"value": "other", "name": "Other"},
                {"value": "gpt-5.6-sol", "name": "GPT 5.6 Sol"}
            ]
        }]);
        assert_eq!(
            exact_model_selection(&options, "gpt-5.6-sol").unwrap(),
            ModelSelection {
                config_id: "model".to_owned(),
                current_value: Some("other".to_owned()),
            }
        );
        assert!(matches!(
            exact_model_selection(&options, "GPT 5.6 Sol"),
            Err(BackendError::Unsupported(_))
        ));
    }

    #[test]
    fn model_catalog_preserves_value_ids_and_display_names() {
        let options = json!([{
            "id": "model",
            "category": "model",
            "currentValue": "a",
            "options": [
                {"group": "openai", "options": [{"value": "a", "name": "Model A"}]},
                {"group": "other", "options": [{"value": "b", "name": "Model B"}]}
            ]
        }]);
        let models = model_descriptors(
            &options,
            &BackendId::parse("pi-acp").unwrap(),
            &ProviderId::parse("openai").unwrap(),
        )
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[1].target.model.as_str(), "b");
        assert_eq!(models[1].name, "Model B");
        assert!(exact_model_selection(&options, "b").is_ok());
    }

    #[test]
    fn backend_rejects_non_exact_target_features_before_spawning() {
        let mut backend = AcpBackend::new(config());
        let mut target = model();
        target.inference.effort = Some(InferenceEffort::High);
        let tools = ToolProvision::default()
            .prepare(&backend.capabilities())
            .unwrap();
        assert!(matches!(
            backend.open_session(BackendSessionRequest {
                model: target,
                tools,
            }),
            Err(BackendError::Unsupported(_))
        ));
    }

    #[test]
    fn acp_backend_advertises_persistent_sessions_and_native_tool_bridge() {
        let capabilities = AcpBackend::new(config()).capabilities();
        assert!(capabilities.persistent_sessions);
        assert!(capabilities
            .tool_presentations
            .contains(&ToolPresentation::AcpExtension));
    }
}
