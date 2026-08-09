#![forbid(unsafe_code)]

mod gateway;
mod permission;
mod projection;
mod state;
mod terminal;

pub use gateway::{AcpGatewayTransport, AcpTreeControl};

use base64::Engine;
use futures::channel::mpsc;
use futures::future::FutureExt;
use futures::stream::StreamExt;
use permission::{PermissionBroker, PermissionRequestEvent};
use phenix_acp::acp::schema::v1::{
    AuthCapabilities, AuthMethod as AcpAuthMethod, AuthenticateRequest,
    BooleanConfigOptionCapabilities, CancelNotification, ClientCapabilities,
    ClientSessionCapabilities, ContentBlock, CreateTerminalRequest, ExtRequest, ForkSessionRequest,
    ImageContent, InitializeRequest, KillTerminalRequest, ListSessionsRequest, LoadSessionRequest,
    LogoutRequest, NewSessionRequest, PromptRequest, PromptResponse, ReleaseTerminalRequest,
    RequestPermissionRequest, ResumeSessionRequest, SessionConfigKind, SessionConfigOptionCategory,
    SessionConfigOptionValue, SessionConfigOptionsCapabilities, SessionModeId, SessionNotification,
    SetSessionConfigOptionRequest, SetSessionModeRequest, TerminalOutputRequest, TextContent,
    WaitForTerminalExitRequest,
};
use phenix_acp::acp::schema::ProtocolVersion;
use phenix_acp::acp::{AcpAgent, Agent, Client, ConnectionTo};
use phenix_runtime_api::{
    AgentBackend, AuthFlowId, BackendCommand, BackendError, BackendEvent, BackendOutputSender,
    BackendReply, BackendRequest, CommandSource, CommandSummary, ExternalCommand,
    NotificationLevel, PersistedSessionTreeSnapshot, RunId, RunState, SessionEntrySummary,
    SessionId, StreamingBehavior, TranscriptBlock, TranscriptRole,
};
use projection::{apply_session_notification, apply_terminal_event, finish_prompt};
use state::{thinking_level_value, AdapterState, PendingPrompt};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use terminal::{TerminalEvent, TerminalManager};

const RELAY_POLL_PERIOD: Duration = Duration::from_millis(100);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpBackendConfig {
    pub command: String,
    pub cwd: PathBuf,
}

impl AcpBackendConfig {
    pub fn new(command: impl Into<String>, cwd: impl Into<PathBuf>) -> Result<Self, ConfigError> {
        let command = command.into();
        if command.trim().is_empty() {
            return Err(ConfigError::EmptyCommand);
        }
        Ok(Self {
            command,
            cwd: cwd.into(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigError {
    EmptyCommand,
}

impl Display for ConfigError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyCommand => formatter.write_str("ACP agent command must not be empty"),
        }
    }
}

impl Error for ConfigError {}

/// Standard ACP client adapter used by the frontend and by downstream gateway
/// transports. Optional startup requests are sent only after the ACP initialize
/// handshake and before frontend runtime requests are accepted; this is how the
/// frontend configures a bare Phenix conductor through its public wire API.
pub struct AcpAgentBackend {
    config: AcpBackendConfig,
    startup_requests: Vec<ExtRequest>,
}

impl AcpAgentBackend {
    pub fn new(config: AcpBackendConfig) -> Self {
        Self {
            config,
            startup_requests: Vec::new(),
        }
    }

    pub fn with_startup_request(mut self, request: ExtRequest) -> Self {
        self.startup_requests.push(request);
        self
    }
}

impl AgentBackend for AcpAgentBackend {
    fn run(
        self: Box<Self>,
        requests: Receiver<BackendRequest>,
        outputs: BackendOutputSender,
    ) -> Result<(), BackendError> {
        let AcpAgentBackend {
            config,
            startup_requests,
        } = *self;
        let agent = AcpAgent::from_str(&config.command)
            .map_err(|error| BackendError::Start(error.to_string()))?;
        let (request_tx, request_rx) = mpsc::unbounded();
        let stop_relay = Arc::new(AtomicBool::new(false));
        let relay_stop = Arc::clone(&stop_relay);
        let relay = thread::Builder::new()
            .name("phenix-acp-request-relay".to_owned())
            .spawn(move || loop {
                match requests.recv_timeout(RELAY_POLL_PERIOD) {
                    Ok(request) => {
                        let shutdown = matches!(request.command, BackendCommand::Shutdown);
                        if request_tx.unbounded_send(request).is_err() || shutdown {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) if relay_stop.load(Ordering::Acquire) => break,
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            })
            .map_err(|error| BackendError::Start(error.to_string()))?;

        let result = futures::executor::block_on(run_connection(
            agent,
            config,
            startup_requests,
            request_rx,
            outputs,
        ));
        stop_relay.store(true, Ordering::Release);
        relay.join().map_err(|_| BackendError::Panicked)?;
        result
    }
}

enum InternalEvent {
    SessionNotification(SessionNotification),
    PromptFinished {
        session_id: phenix_acp::acp::schema::v1::SessionId,
        result: Result<PromptResponse, String>,
    },
    Permission(PermissionRequestEvent),
    Terminal(TerminalEvent),
}

struct RuntimeState {
    adapter: AdapterState,
    permissions: PermissionBroker,
    pending_terminal_auth: BTreeMap<AuthFlowId, String>,
    next_auth_flow: u64,
}

impl RuntimeState {
    fn new(adapter: AdapterState) -> Self {
        Self {
            adapter,
            permissions: PermissionBroker::default(),
            pending_terminal_auth: BTreeMap::new(),
            next_auth_flow: 1,
        }
    }

    fn next_auth_flow(&mut self) -> Result<AuthFlowId, BackendError> {
        let flow = AuthFlowId::parse(format!("acp-auth-{}", self.next_auth_flow))
            .map_err(|error| BackendError::Protocol(error.to_string()))?;
        self.next_auth_flow = self.next_auth_flow.checked_add(1).ok_or_else(|| {
            BackendError::Protocol("authentication flow IDs exhausted".to_owned())
        })?;
        Ok(flow)
    }
}

async fn run_connection(
    agent: AcpAgent,
    config: AcpBackendConfig,
    startup_requests: Vec<ExtRequest>,
    requests: mpsc::UnboundedReceiver<BackendRequest>,
    outputs: BackendOutputSender,
) -> Result<(), BackendError> {
    let (internal_tx, internal_rx) = mpsc::unbounded();
    let (terminal_tx, mut terminal_rx) = mpsc::unbounded();
    let terminals = TerminalManager::new(terminal_tx);
    let terminal_event_tx = internal_tx.clone();
    let _terminal_forwarder = thread::Builder::new()
        .name("phenix-acp-terminal-events".to_owned())
        .spawn(move || {
            futures::executor::block_on(async move {
                while let Some(event) = terminal_rx.next().await {
                    if terminal_event_tx
                        .unbounded_send(InternalEvent::Terminal(event))
                        .is_err()
                    {
                        break;
                    }
                }
            });
        })
        .map_err(|error| BackendError::Start(error.to_string()))?;

    let session_tx = internal_tx.clone();
    let permission_tx = internal_tx.clone();
    let create_terminals = terminals.clone();
    let output_terminals = terminals.clone();
    let wait_terminals = terminals.clone();
    let kill_terminals = terminals.clone();
    let release_terminals = terminals;

    Client
        .builder()
        .on_receive_notification(
            async move |notification: SessionNotification, _cx| {
                session_tx
                    .unbounded_send(InternalEvent::SessionNotification(notification))
                    .map_err(|_| phenix_acp::acp::Error::internal_error())
            },
            phenix_acp::acp::on_receive_notification!(),
        )
        .on_receive_request(
            async move |request: RequestPermissionRequest, responder, _cx| {
                let (response_tx, response_rx) = futures::channel::oneshot::channel();
                permission_tx
                    .unbounded_send(InternalEvent::Permission(PermissionRequestEvent {
                        request,
                        response: response_tx,
                    }))
                    .map_err(|_| phenix_acp::acp::Error::internal_error())?;
                let response = response_rx
                    .await
                    .map_err(|_| phenix_acp::acp::Error::internal_error())?;
                responder.respond(response)
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CreateTerminalRequest, responder, _cx| {
                responder.respond(create_terminals.create(request).await?)
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: TerminalOutputRequest, responder, _cx| {
                responder.respond(output_terminals.output(request).await?)
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: WaitForTerminalExitRequest, responder, _cx| {
                responder.respond(wait_terminals.wait(request).await?)
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: KillTerminalRequest, responder, _cx| {
                responder.respond(kill_terminals.kill(request).await?)
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ReleaseTerminalRequest, responder, _cx| {
                responder.respond(release_terminals.release(request).await?)
            },
            phenix_acp::acp::on_receive_request!(),
        )
        .name("phenix-acp")
        .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
            let initialize = InitializeRequest::new(ProtocolVersion::V1).client_capabilities(
                ClientCapabilities::new()
                    .terminal(true)
                    .auth(AuthCapabilities::new().terminal(true))
                    .session(
                        ClientSessionCapabilities::new().config_options(
                            SessionConfigOptionsCapabilities::new()
                                .boolean(BooleanConfigOptionCapabilities::new()),
                        ),
                    ),
            );
            let initialize = cx.send_request(initialize).block_task().await?;
            for request in startup_requests {
                let request = phenix_acp::acp::UntypedMessage::new(
                    request.method.as_ref(),
                    request.params.as_ref(),
                )?;
                let _: serde_json::Value = cx.send_request(request).block_task().await?;
            }
            let runtime = RuntimeState::new(AdapterState::new(initialize));
            run_backend_loop(
                cx,
                config,
                runtime,
                requests,
                internal_rx,
                internal_tx,
                outputs,
            )
            .await
            .map_err(to_acp_error)
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))
}

async fn run_backend_loop(
    connection: ConnectionTo<Agent>,
    config: AcpBackendConfig,
    mut runtime: RuntimeState,
    mut requests: mpsc::UnboundedReceiver<BackendRequest>,
    mut internal: mpsc::UnboundedReceiver<InternalEvent>,
    internal_tx: mpsc::UnboundedSender<InternalEvent>,
    outputs: BackendOutputSender,
) -> Result<(), BackendError> {
    loop {
        futures::select! {
            request = requests.next().fuse() => {
                let Some(request) = request else {
                    runtime.permissions.cancel_all();
                    return Ok(());
                };
                if handle_request(
                    &connection,
                    &config,
                    &mut runtime,
                    request,
                    &internal_tx,
                    &outputs,
                ).await? {
                    runtime.permissions.cancel_all();
                    return Ok(());
                }
            }
            event = internal.next().fuse() => {
                let Some(event) = event else {
                    return Err(BackendError::Transport(
                        "ACP internal event channel closed".to_owned(),
                    ));
                };
                handle_internal_event(
                    &connection,
                    &mut runtime,
                    event,
                    &internal_tx,
                    &outputs,
                ).await?;
            }
        }
    }
}

async fn handle_request(
    connection: &ConnectionTo<Agent>,
    config: &AcpBackendConfig,
    runtime: &mut RuntimeState,
    request: BackendRequest,
    internal_tx: &mpsc::UnboundedSender<InternalEvent>,
    outputs: &BackendOutputSender,
) -> Result<bool, BackendError> {
    let result = match request.command {
        BackendCommand::Initialize { .. } => {
            if runtime.adapter.sessions.is_empty() {
                match create_session(connection, runtime, config.cwd.clone(), None).await {
                    Ok(_) => {}
                    Err(error) => outputs.event(BackendEvent::Notification {
                        level: NotificationLevel::Warning,
                        message: format!(
                            "ACP initialized without a session: {error}. Authenticate or create a session."
                        ),
                    })?,
                }
            }
            Ok(BackendReply::Initialized {
                capabilities: runtime.adapter.capabilities.clone(),
                snapshot: runtime.adapter.snapshot(),
            })
        }
        BackendCommand::SnapshotRequest => Ok(BackendReply::Snapshot(runtime.adapter.snapshot())),
        BackendCommand::PromptSubmit {
            run_id,
            text,
            images,
            streaming_behavior,
        } => match streaming_behavior {
            Some(StreamingBehavior::FollowUp) => {
                queue_follow_up(
                    connection,
                    runtime,
                    run_id,
                    PendingPrompt { text, images },
                    internal_tx,
                    outputs,
                )?;
                Ok(BackendReply::Accepted)
            }
            Some(StreamingBehavior::Steer) => {
                steer_prompt(
                    connection,
                    runtime,
                    run_id,
                    PendingPrompt { text, images },
                    internal_tx,
                    outputs,
                )?;
                Ok(BackendReply::Accepted)
            }
            None => {
                // Normal user submits are sequential conversation turns. If the
                // previous ACP prompt has not delivered its PromptFinished event
                // yet, preserve the turn by queueing it instead of racing the
                // adapter's active-prompt invariant.
                queue_follow_up(
                    connection,
                    runtime,
                    run_id,
                    PendingPrompt { text, images },
                    internal_tx,
                    outputs,
                )?;
                Ok(BackendReply::Accepted)
            }
        },
        BackendCommand::PromptSteer {
            run_id,
            text,
            images,
        } => {
            steer_prompt(
                connection,
                runtime,
                run_id,
                PendingPrompt { text, images },
                internal_tx,
                outputs,
            )?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::PromptFollowUp {
            run_id,
            text,
            images,
        } => {
            queue_follow_up(
                connection,
                runtime,
                run_id,
                PendingPrompt { text, images },
                internal_tx,
                outputs,
            )?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::ExecutionAbort { run_id } => {
            let session = match run_id {
                Some(run_id) => runtime.adapter.session_for_run(&run_id)?,
                None => runtime.adapter.active_session_mut()?,
            };
            connection
                .send_notification(CancelNotification::new(session.acp_id.clone()))
                .map_err(acp_protocol_error)?;
            runtime.permissions.cancel_session(&session.acp_id);
            Ok(BackendReply::Accepted)
        }
        BackendCommand::SessionCreate { parent_session } => {
            create_session(
                connection,
                runtime,
                config.cwd.clone(),
                parent_session.as_ref(),
            )
            .await?;
            outputs.event(BackendEvent::SnapshotChanged(runtime.adapter.snapshot()))?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::SessionSwitch { session_id } => {
            switch_session(connection, runtime, session_id, config.cwd.clone()).await?;
            outputs.event(BackendEvent::SnapshotChanged(runtime.adapter.snapshot()))?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::SessionFork {
            session_id,
            entry_id: _,
        }
        | BackendCommand::SessionClone { session_id } => {
            fork_session(connection, runtime, session_id, config.cwd.clone()).await?;
            outputs.event(BackendEvent::SnapshotChanged(runtime.adapter.snapshot()))?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::SessionRename { session_id, name } => {
            let session = runtime.adapter.sessions.get(&session_id).ok_or_else(|| {
                BackendError::InvalidConfiguration(format!("unknown session {session_id}"))
            })?;
            invoke_command(
                connection,
                runtime,
                session.run.id.clone(),
                "name".to_owned(),
                name,
                internal_tx,
                outputs,
            )?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::SessionList => {
            let response = connection
                .send_request(ListSessionsRequest::new())
                .block_task()
                .await
                .map_err(acp_transport_error)?;
            Ok(BackendReply::Sessions(
                response
                    .sessions
                    .into_iter()
                    .filter_map(project_session_summary)
                    .collect(),
            ))
        }
        BackendCommand::SessionTree { session_id } => {
            let session = runtime.adapter.sessions.get(&session_id).ok_or_else(|| {
                BackendError::InvalidConfiguration(format!("unknown session {session_id}"))
            })?;
            Ok(BackendReply::SessionTree(PersistedSessionTreeSnapshot {
                session_id,
                leaf_entry: None,
                entries: vec![SessionEntrySummary {
                    id: phenix_runtime_api::SessionEntryId::parse(session.run.id.to_string())
                        .map_err(|error| BackendError::Protocol(error.to_string()))?,
                    parent: None,
                    kind: phenix_runtime_api::SessionEntryKind::Other,
                    label: Some(
                        "ACP session; run hierarchy is exposed through snapshot.runs".to_owned(),
                    ),
                }],
            }))
        }
        BackendCommand::SessionExport { .. } => Err(BackendError::Unsupported(
            "ACP v1 has no standard session export operation".to_owned(),
        )),
        BackendCommand::SessionModes { run_id } => Ok(BackendReply::SessionModes(
            runtime.adapter.session_for_run(&run_id)?.mode_summaries(),
        )),
        BackendCommand::SessionModeSelect { run_id, mode_id } => {
            let session = runtime.adapter.session_for_run(&run_id)?;
            connection
                .send_request(SetSessionModeRequest::new(
                    session.acp_id.clone(),
                    SessionModeId::new(mode_id.clone()),
                ))
                .block_task()
                .await
                .map_err(acp_transport_error)?;
            let session = runtime.adapter.session_for_run_mut(&run_id)?;
            if let Some(modes) = &mut session.modes {
                modes.current_mode_id = SessionModeId::new(mode_id.clone());
            }
            outputs.event(BackendEvent::StatusChanged {
                key: "mode".to_owned(),
                text: Some(mode_id),
            })?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::ModelList => {
            let supports_images = runtime.adapter.capabilities.prompting.images;
            let models = runtime
                .adapter
                .active_session_mut()?
                .models(supports_images);
            Ok(BackendReply::Models(models))
        }
        BackendCommand::ModelSelect { run_id, model } => {
            set_select_config(
                connection,
                runtime,
                &run_id,
                SessionConfigOptionCategory::Model,
                format!("{}/{}", model.provider, model.model),
            )
            .await?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::ThinkingLevels { run_id } => Ok(BackendReply::ThinkingLevels(
            runtime.adapter.session_for_run(&run_id)?.thinking_levels(),
        )),
        BackendCommand::ThinkingSelect { run_id, level } => {
            set_select_config(
                connection,
                runtime,
                &run_id,
                SessionConfigOptionCategory::ThoughtLevel,
                thinking_level_value(&level).to_owned(),
            )
            .await?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::AuthProviders => Ok(BackendReply::AuthProviders(
            runtime.adapter.auth_providers(),
        )),
        BackendCommand::AuthLoginStart {
            provider_id,
            method: _,
        } => {
            start_authentication(config, connection, runtime, provider_id, outputs).await?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::AuthTerminalFinished {
            flow_id,
            success,
            message,
        } => {
            let provider_id = runtime
                .pending_terminal_auth
                .remove(&flow_id)
                .ok_or_else(|| {
                    BackendError::InvalidConfiguration(format!(
                        "terminal authentication flow {flow_id} is not pending"
                    ))
                })?;
            let result = if success && runtime.adapter.sessions.is_empty() {
                create_session(connection, runtime, config.cwd.clone(), None)
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            } else if success {
                Ok(())
            } else {
                Err(message.unwrap_or_else(|| "terminal authentication command failed".to_owned()))
            };
            if result.is_ok() {
                outputs.event(BackendEvent::SnapshotChanged(runtime.adapter.snapshot()))?;
            }
            outputs.event(BackendEvent::AuthFinished {
                flow_id,
                provider_id,
                result,
            })?;
            Ok(BackendReply::Completed)
        }
        BackendCommand::AuthLoginRespond { .. } => Err(BackendError::Unsupported(
            "ACP authentication methods do not use Phenix prompt responses".to_owned(),
        )),
        BackendCommand::AuthLoginCancel { flow_id } => {
            runtime.pending_terminal_auth.remove(&flow_id);
            Ok(BackendReply::Completed)
        }
        BackendCommand::AuthLogout { provider_id: _ } => {
            connection
                .send_request(LogoutRequest::new())
                .block_task()
                .await
                .map_err(acp_transport_error)?;
            Ok(BackendReply::Completed)
        }
        BackendCommand::CompactionStart {
            run_id,
            instructions,
        } => {
            let command = runtime
                .adapter
                .session_for_run(&run_id)?
                .commands
                .iter()
                .find(|command| matches!(command.name.as_str(), "compact" | "compaction"))
                .map(|command| command.name.clone())
                .ok_or_else(|| {
                    BackendError::Unsupported(
                        "the ACP agent did not advertise a compaction command".to_owned(),
                    )
                })?;
            invoke_command(
                connection,
                runtime,
                run_id,
                command,
                instructions.unwrap_or_default(),
                internal_tx,
                outputs,
            )?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::CompactionAbort { run_id } => {
            let session = runtime.adapter.session_for_run(&run_id)?;
            connection
                .send_notification(CancelNotification::new(session.acp_id.clone()))
                .map_err(acp_protocol_error)?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::RetryConfigure { .. } | BackendCommand::RetryAbort { .. } => Err(
            BackendError::Unsupported("ACP does not standardize retry control".to_owned()),
        ),
        BackendCommand::CommandList => {
            let commands = runtime
                .adapter
                .active_session_mut()?
                .commands
                .iter()
                .map(|command| CommandSummary {
                    name: command.name.clone(),
                    description: Some(command.description.clone()),
                    source: CommandSource::BuiltIn,
                })
                .collect();
            Ok(BackendReply::Commands(commands))
        }
        BackendCommand::CommandInvoke {
            run_id,
            name,
            arguments,
        } => {
            invoke_command(
                connection,
                runtime,
                run_id,
                name,
                arguments,
                internal_tx,
                outputs,
            )?;
            Ok(BackendReply::Accepted)
        }
        BackendCommand::ResourceReload => Err(BackendError::Unsupported(
            "ACP v1 has no generic resource reload operation".to_owned(),
        )),
        BackendCommand::ExtensionUiRespond {
            dialog_id,
            response,
        } => {
            runtime.permissions.respond(&dialog_id, response)?;
            Ok(BackendReply::Completed)
        }
        BackendCommand::Shutdown => {
            outputs.reply(request.id, Ok(BackendReply::Completed))?;
            return Ok(true);
        }
    };
    outputs.reply(request.id, result)?;
    Ok(false)
}

async fn handle_internal_event(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    event: InternalEvent,
    internal_tx: &mpsc::UnboundedSender<InternalEvent>,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    match event {
        InternalEvent::SessionNotification(notification) => {
            apply_session_notification(&mut runtime.adapter, notification, outputs)?;
        }
        InternalEvent::Permission(event) => runtime.permissions.request(event, outputs)?,
        InternalEvent::Terminal(event) => {
            apply_terminal_event(&runtime.adapter, event, outputs)?;
        }
        InternalEvent::PromptFinished { session_id, result } => {
            let phenix_session =
                runtime
                    .adapter
                    .session_id_by_acp(&session_id)
                    .ok_or_else(|| {
                        BackendError::Protocol(format!(
                            "prompt completed for unknown ACP session {session_id}"
                        ))
                    })?;
            let next = {
                let session = runtime
                    .adapter
                    .sessions
                    .get_mut(&phenix_session)
                    .ok_or_else(|| {
                        BackendError::Protocol(format!(
                            "prompt session {phenix_session} disappeared"
                        ))
                    })?;
                match result {
                    Ok(response) => finish_prompt(session, response.stop_reason, outputs)?,
                    Err(message) => {
                        session.prompt_active = false;
                        session.run.state = RunState::Failed;
                        session.run.outcome = Some(phenix_runtime_api::RunOutcome::Failure {
                            code: "acp.prompt".to_owned(),
                            message,
                            retryable: true,
                        });
                        outputs.event(BackendEvent::RunChanged(session.run.clone()))?;
                    }
                }
                let next = session.follow_ups.pop_front();
                session.run.pending_messages = session.follow_ups.len();
                emit_queue_state(session, 0, outputs)?;
                next.map(|prompt| (session.run.id.clone(), prompt))
            };
            if let Some((run_id, prompt)) = next {
                start_prompt(connection, runtime, run_id, prompt, internal_tx, outputs)?;
            }
        }
    }
    Ok(())
}

async fn create_session(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    cwd: PathBuf,
    parent: Option<&SessionId>,
) -> Result<SessionId, BackendError> {
    let response = connection
        .send_request(NewSessionRequest::new(cwd.clone()))
        .block_task()
        .await
        .map_err(acp_transport_error)?;
    runtime.adapter.insert_session(
        response.session_id,
        cwd,
        parent,
        response.modes,
        response.config_options,
        None,
        None,
    )
}

async fn switch_session(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    session_id: SessionId,
    cwd: PathBuf,
) -> Result<(), BackendError> {
    if runtime.adapter.sessions.contains_key(&session_id) {
        runtime.adapter.active_session = Some(session_id);
        return Ok(());
    }
    let acp_id = phenix_acp::acp::schema::v1::SessionId::new(session_id.to_string());
    if runtime
        .adapter
        .initialize
        .agent_capabilities
        .session_capabilities
        .resume
        .is_some()
    {
        let response = connection
            .send_request(ResumeSessionRequest::new(acp_id.clone(), cwd.clone()))
            .block_task()
            .await
            .map_err(acp_transport_error)?;
        runtime.adapter.insert_session(
            acp_id,
            cwd,
            None,
            response.modes,
            response.config_options,
            None,
            None,
        )?;
    } else if runtime.adapter.initialize.agent_capabilities.load_session {
        let response = connection
            .send_request(LoadSessionRequest::new(acp_id.clone(), cwd.clone()))
            .block_task()
            .await
            .map_err(acp_transport_error)?;
        runtime.adapter.insert_session(
            acp_id,
            cwd,
            None,
            response.modes,
            response.config_options,
            None,
            None,
        )?;
    } else {
        return Err(BackendError::Unsupported(
            "the ACP agent cannot load or resume sessions".to_owned(),
        ));
    }
    Ok(())
}

async fn fork_session(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    session_id: SessionId,
    cwd: PathBuf,
) -> Result<SessionId, BackendError> {
    let parent = runtime.adapter.sessions.get(&session_id).ok_or_else(|| {
        BackendError::InvalidConfiguration(format!("unknown session {session_id}"))
    })?;
    if runtime
        .adapter
        .initialize
        .agent_capabilities
        .session_capabilities
        .fork
        .is_none()
    {
        return Err(BackendError::Unsupported(
            "the ACP agent does not support session forking".to_owned(),
        ));
    }
    let response = connection
        .send_request(ForkSessionRequest::new(parent.acp_id.clone(), cwd.clone()))
        .block_task()
        .await
        .map_err(acp_transport_error)?;
    runtime.adapter.insert_session(
        response.session_id,
        cwd,
        Some(&session_id),
        response.modes,
        response.config_options,
        None,
        None,
    )
}

fn start_prompt(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    run_id: RunId,
    prompt: PendingPrompt,
    internal_tx: &mpsc::UnboundedSender<InternalEvent>,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    let supports_images = runtime.adapter.capabilities.prompting.images;
    if !prompt.images.is_empty() && !supports_images {
        return Err(BackendError::Unsupported(
            "the ACP agent does not accept image prompt blocks".to_owned(),
        ));
    }
    let session = runtime.adapter.session_for_run_mut(&run_id)?;
    if session.prompt_active {
        return Err(BackendError::InvalidConfiguration(format!(
            "run {run_id} already has an active ACP prompt"
        )));
    }
    let mut content: Vec<ContentBlock> =
        vec![ContentBlock::Text(TextContent::new(prompt.text.clone()))];
    for image in prompt.images {
        content.push(ContentBlock::Image(ImageContent::new(
            base64::engine::general_purpose::STANDARD.encode(image.bytes),
            image.media_type,
        )));
    }
    let acp_session_id = session.acp_id.clone();
    let completion_session_id = acp_session_id.clone();
    let completion_tx = internal_tx.clone();
    connection
        .send_request(PromptRequest::new(acp_session_id, content))
        .on_receiving_result(async move |result| {
            completion_tx
                .unbounded_send(InternalEvent::PromptFinished {
                    session_id: completion_session_id,
                    result: result.map_err(|error| error.to_string()),
                })
                .map_err(|_| phenix_acp::acp::Error::internal_error())?;
            Ok(())
        })
        .map_err(acp_protocol_error)?;
    session.prompt_active = true;
    session.run.state = RunState::Running;
    session.run.outcome = None;
    outputs.event(BackendEvent::TranscriptAppended(TranscriptBlock {
        id: session.next_transcript_key("acp-user")?,
        run_id: run_id.clone(),
        role: TranscriptRole::User,
        text: prompt.text,
        complete: true,
    }))?;
    outputs.event(BackendEvent::RunChanged(session.run.clone()))?;
    Ok(())
}

fn queue_follow_up(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    run_id: RunId,
    prompt: PendingPrompt,
    internal_tx: &mpsc::UnboundedSender<InternalEvent>,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    if runtime.adapter.session_for_run(&run_id)?.prompt_active {
        let session = runtime.adapter.session_for_run_mut(&run_id)?;
        session.follow_ups.push_back(prompt);
        session.run.pending_messages = session.follow_ups.len();
        emit_queue_state(session, 0, outputs)
    } else {
        start_prompt(connection, runtime, run_id, prompt, internal_tx, outputs)
    }
}

fn steer_prompt(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    run_id: RunId,
    prompt: PendingPrompt,
    internal_tx: &mpsc::UnboundedSender<InternalEvent>,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    let session = runtime.adapter.session_for_run(&run_id)?;
    if !session.prompt_active {
        return start_prompt(connection, runtime, run_id, prompt, internal_tx, outputs);
    }
    connection
        .send_notification(CancelNotification::new(session.acp_id.clone()))
        .map_err(acp_protocol_error)?;
    runtime.permissions.cancel_session(&session.acp_id);
    let session = runtime.adapter.session_for_run_mut(&run_id)?;
    session.follow_ups.push_front(prompt);
    session.run.pending_messages = session.follow_ups.len();
    emit_queue_state(session, 1, outputs)
}

fn emit_queue_state(
    session: &state::SessionState,
    steering_count: usize,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    let steering = session
        .follow_ups
        .iter()
        .take(steering_count)
        .map(|prompt| prompt.text.clone())
        .collect();
    let follow_ups = session
        .follow_ups
        .iter()
        .skip(steering_count)
        .map(|prompt| prompt.text.clone())
        .collect();
    outputs.event(BackendEvent::QueueChanged {
        run_id: session.run.id.clone(),
        steering,
        follow_ups,
    })
}

fn invoke_command(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    run_id: RunId,
    name: String,
    arguments: String,
    internal_tx: &mpsc::UnboundedSender<InternalEvent>,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    let advertised = runtime
        .adapter
        .session_for_run(&run_id)?
        .commands
        .iter()
        .any(|command| command.name == name);
    if !advertised {
        return Err(BackendError::Unsupported(format!(
            "the ACP agent did not advertise /{name}"
        )));
    }
    let text = if arguments.trim().is_empty() {
        format!("/{name}")
    } else {
        format!("/{name} {}", arguments.trim())
    };
    queue_follow_up(
        connection,
        runtime,
        run_id,
        PendingPrompt {
            text,
            images: Vec::new(),
        },
        internal_tx,
        outputs,
    )
}

async fn set_select_config(
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    run_id: &RunId,
    category: SessionConfigOptionCategory,
    value: String,
) -> Result<(), BackendError> {
    let session = runtime.adapter.session_for_run(run_id)?;
    let option = session
        .config_options
        .iter()
        .find(|option| option.category.as_ref() == Some(&category))
        .ok_or_else(|| {
            BackendError::Unsupported(format!(
                "the ACP session did not advertise a {category:?} configuration option"
            ))
        })?;
    if matches!(option.kind, SessionConfigKind::Boolean(_)) {
        return Err(BackendError::Unsupported(format!(
            "{category:?} is a boolean ACP option and cannot select `{value}`"
        )));
    }
    let response = connection
        .send_request(SetSessionConfigOptionRequest::new(
            session.acp_id.clone(),
            option.id.clone(),
            SessionConfigOptionValue::value_id(value),
        ))
        .block_task()
        .await
        .map_err(acp_transport_error)?;
    let session = runtime.adapter.session_for_run_mut(run_id)?;
    session.config_options = response.config_options;
    session.run.model = session.current_model();
    session.run.thinking_level = session.current_thinking_level();
    runtime.adapter.refresh_capabilities();
    Ok(())
}

async fn start_authentication(
    config: &AcpBackendConfig,
    connection: &ConnectionTo<Agent>,
    runtime: &mut RuntimeState,
    provider_id: String,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    let method = runtime
        .adapter
        .initialize
        .auth_methods
        .iter()
        .find(|method| match method {
            AcpAuthMethod::Agent(method) => method.id.to_string() == provider_id,
            AcpAuthMethod::Terminal(method) => method.id.to_string() == provider_id,
            _ => false,
        })
        .cloned()
        .ok_or_else(|| {
            BackendError::InvalidConfiguration(format!(
                "unknown ACP authentication method {provider_id}"
            ))
        })?;
    let flow_id = runtime.next_auth_flow()?;
    match method {
        AcpAuthMethod::Agent(method) => {
            let mut result = connection
                .send_request(AuthenticateRequest::new(method.id))
                .block_task()
                .await
                .map(|_| ())
                .map_err(|error| error.to_string());
            if result.is_ok() && runtime.adapter.sessions.is_empty() {
                result = create_session(connection, runtime, config.cwd.clone(), None)
                    .await
                    .map(|_| ())
                    .map_err(|error| error.to_string());
            }
            if result.is_ok() {
                outputs.event(BackendEvent::SnapshotChanged(runtime.adapter.snapshot()))?;
            }
            outputs.event(BackendEvent::AuthFinished {
                flow_id,
                provider_id,
                result,
            })?;
        }
        AcpAuthMethod::Terminal(method) => {
            let mut invocation = shell_words::split(&config.command).map_err(|error| {
                BackendError::InvalidConfiguration(format!(
                    "cannot parse ACP agent command for terminal authentication: {error}"
                ))
            })?;
            if invocation.is_empty() {
                return Err(BackendError::InvalidConfiguration(
                    "ACP agent command is empty".to_owned(),
                ));
            }
            let program = invocation.remove(0);
            invocation.extend(method.args);
            let command = ExternalCommand {
                program,
                arguments: invocation,
                environment: method.env.into_iter().collect(),
            };
            runtime
                .pending_terminal_auth
                .insert(flow_id.clone(), provider_id.clone());
            outputs.event(BackendEvent::ExternalCommandRequested { flow_id, command })?;
        }
        _ => {
            return Err(BackendError::Unsupported(
                "unsupported ACP authentication method variant".to_owned(),
            ));
        }
    }
    Ok(())
}

fn project_session_summary(
    session: phenix_acp::acp::schema::v1::SessionInfo,
) -> Option<phenix_runtime_api::PersistedSessionSummary> {
    Some(phenix_runtime_api::PersistedSessionSummary {
        id: SessionId::parse(session.session_id.to_string()).ok()?,
        name: session.title,
        session_file: None,
        cwd: Some(session.cwd.to_string_lossy().into_owned()),
        root_run_id: None,
        updated_at: session.updated_at,
    })
}

fn acp_transport_error(error: phenix_acp::acp::Error) -> BackendError {
    BackendError::Transport(error.to_string())
}

fn acp_protocol_error(error: phenix_acp::acp::Error) -> BackendError {
    BackendError::Protocol(error.to_string())
}

fn to_acp_error(error: BackendError) -> phenix_acp::acp::Error {
    phenix_acp::acp::Error::internal_error().data(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_is_validated_before_process_start() {
        assert_eq!(
            AcpBackendConfig::new("", "."),
            Err(ConfigError::EmptyCommand)
        );
    }

    #[test]
    fn terminal_auth_uses_the_original_agent_invocation() {
        let invocation = shell_words::split("npx -y pi-acp").expect("parse invocation");
        assert_eq!(invocation, vec!["npx", "-y", "pi-acp"]);
    }
}
