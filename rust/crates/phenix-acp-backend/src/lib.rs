#![forbid(unsafe_code)]

use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, ContentChunk, InitializeRequest, SessionNotification,
    SessionUpdate, StopReason,
};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectionTo, SessionMessage};
use futures::channel::mpsc;
use futures::future::{self, Either, FutureExt};
use futures::stream::StreamExt;
use phenix_runtime_api::{
    AgentBackend, BackendCapabilities, BackendCommand, BackendError, BackendEvent, BackendHealth,
    BackendOutputSender, BackendReply, BackendRequest, PersistedSessionSummary, PromptCapabilities,
    RunId, RunKind, RunOutcome, RunState, RunSummary, RuntimeSnapshot, SessionId, TranscriptBlock,
    TranscriptRole,
};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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

pub struct AcpAgentBackend {
    config: AcpBackendConfig,
}

impl AcpAgentBackend {
    pub fn new(config: AcpBackendConfig) -> Self {
        Self { config }
    }
}

impl AgentBackend for AcpAgentBackend {
    fn run(
        self: Box<Self>,
        requests: Receiver<BackendRequest>,
        outputs: BackendOutputSender,
    ) -> Result<(), BackendError> {
        let agent = AcpAgent::from_str(&self.config.command)
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
            self.config.cwd,
            request_rx,
            outputs,
        ));
        stop_relay.store(true, Ordering::Release);
        relay.join().map_err(|_| BackendError::Panicked)?;
        result
    }
}

async fn run_connection(
    agent: AcpAgent,
    cwd: PathBuf,
    requests: mpsc::UnboundedReceiver<BackendRequest>,
    outputs: BackendOutputSender,
) -> Result<(), BackendError> {
    Client
        .builder()
        .name("phenix-acp")
        .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
            cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                .block_task()
                .await?;
            let session = cx.build_session(cwd).block_task().start_session().await?;
            run_session(session, requests, outputs)
                .await
                .map_err(to_acp_error)
        })
        .await
        .map_err(|error| BackendError::Transport(error.to_string()))
}

async fn run_session<'a>(
    mut session: agent_client_protocol::ActiveSession<'a, Agent>,
    mut requests: mpsc::UnboundedReceiver<BackendRequest>,
    outputs: BackendOutputSender,
) -> Result<(), BackendError> {
    let session_id = SessionId::parse(session.session_id().to_string())
        .map_err(|error| BackendError::Protocol(error.to_string()))?;
    let root_run = RunId::parse("acp-root")
        .map_err(|error| BackendError::InvalidConfiguration(error.to_string()))?;
    let mut state = AdapterState::new(session_id, root_run);

    loop {
        let next = {
            let request = requests.next().fuse();
            let update = if state.prompt_active {
                Either::Left(session.read_update())
            } else {
                Either::Right(future::pending::<
                    Result<SessionMessage, agent_client_protocol::Error>,
                >())
            }
            .fuse();
            futures::pin_mut!(request, update);
            futures::select! {
                request = request => Next::Request(request),
                update = update => Next::Update(update),
            }
        };

        match next {
            Next::Request(Some(request)) => {
                if handle_request(&mut session, &mut state, request, &outputs)? {
                    return Ok(());
                }
            }
            Next::Request(None) => return Ok(()),
            Next::Update(Ok(update)) => {
                handle_session_message(&mut state, update, &outputs).await?
            }
            Next::Update(Err(error)) => return Err(BackendError::Protocol(error.to_string())),
        }
    }
}

enum Next {
    Request(Option<BackendRequest>),
    Update(Result<SessionMessage, agent_client_protocol::Error>),
}

fn handle_request<'a>(
    session: &mut agent_client_protocol::ActiveSession<'a, Agent>,
    state: &mut AdapterState,
    request: BackendRequest,
    outputs: &BackendOutputSender,
) -> Result<bool, BackendError> {
    let result = match request.command {
        BackendCommand::Initialize { .. } => Ok(BackendReply::Initialized {
            capabilities: state.capabilities.clone(),
            snapshot: state.snapshot(),
        }),
        BackendCommand::SnapshotRequest => Ok(BackendReply::Snapshot(state.snapshot())),
        BackendCommand::PromptSubmit {
            run_id,
            text,
            images,
            streaming_behavior,
        } => {
            state.require_root_run(&run_id)?;
            if !images.is_empty() {
                Err(BackendError::Unsupported(
                    "image prompts are not mapped by the ACP adapter yet".to_owned(),
                ))
            } else if streaming_behavior.is_some() {
                Err(BackendError::Unsupported(
                    "steering and follow-up prompt modes are not mapped by the ACP adapter yet"
                        .to_owned(),
                ))
            } else if state.prompt_active {
                Err(BackendError::Unsupported(
                    "concurrent prompts on one ACP session are not supported".to_owned(),
                ))
            } else {
                session
                    .send_prompt(&text)
                    .map_err(|error| BackendError::Protocol(error.to_string()))?;
                state.begin_prompt(text, outputs)?;
                Ok(BackendReply::Accepted)
            }
        }
        BackendCommand::ExecutionAbort { run_id } => {
            if let Some(run_id) = run_id {
                state.require_root_run(&run_id)?;
            }
            if state.prompt_active {
                session
                    .connection()
                    .send_notification(CancelNotification::new(session.session_id().clone()))
                    .map_err(|error| BackendError::Protocol(error.to_string()))?;
            }
            Ok(BackendReply::Accepted)
        }
        BackendCommand::Shutdown => {
            outputs.reply(request.id, Ok(BackendReply::Completed))?;
            return Ok(true);
        }
        command => Err(BackendError::Unsupported(format!(
            "{} is not mapped by the ACP adapter yet",
            command_name(&command)
        ))),
    };
    outputs.reply(request.id, result)?;
    Ok(false)
}

async fn handle_session_message(
    state: &mut AdapterState,
    message: SessionMessage,
    outputs: &BackendOutputSender,
) -> Result<(), BackendError> {
    match message {
        SessionMessage::SessionMessage(dispatch) => {
            MatchDispatch::new(dispatch)
                .if_notification(async |notification: SessionNotification| {
                    if let SessionUpdate::AgentMessageChunk(ContentChunk {
                        content: ContentBlock::Text(text),
                        ..
                    }) = notification.update
                    {
                        state
                            .append_assistant_text(&text.text, outputs)
                            .map_err(to_acp_error)?;
                    }
                    Ok(())
                })
                .await
                .otherwise_ignore()
                .map_err(|error| BackendError::Protocol(error.to_string()))?;
        }
        SessionMessage::StopReason(reason) => state.finish_prompt(reason, outputs)?,
        _ => {}
    }
    Ok(())
}

struct AdapterState {
    capabilities: BackendCapabilities,
    session_id: SessionId,
    root_run: RunId,
    prompt_active: bool,
    turn_sequence: u64,
    assistant_text: String,
    assistant_block_id: Option<String>,
    run: RunSummary,
}

impl AdapterState {
    fn new(session_id: SessionId, root_run: RunId) -> Self {
        let capabilities = BackendCapabilities {
            prompting: PromptCapabilities {
                steering: false,
                follow_ups: false,
                images: false,
                compaction: false,
                retry_control: false,
            },
            ..BackendCapabilities::default()
        };
        let run = RunSummary {
            id: root_run.clone(),
            parent: None,
            kind: RunKind::Root,
            definition_id: "acp.session".to_owned(),
            display_name: "ACP session".to_owned(),
            state: RunState::Created,
            persisted_session: Some(session_id.clone()),
            session_file: None,
            model: None,
            thinking_level: None,
            difficulty: None,
            budget: None,
            pending_messages: 0,
            outcome: None,
        };
        Self {
            capabilities,
            session_id,
            root_run,
            prompt_active: false,
            turn_sequence: 0,
            assistant_text: String::new(),
            assistant_block_id: None,
            run,
        }
    }

    fn snapshot(&self) -> RuntimeSnapshot {
        RuntimeSnapshot {
            capabilities: self.capabilities.clone(),
            health: BackendHealth::Ready,
            active_session: Some(self.session_id.clone()),
            root_run: Some(self.root_run.clone()),
            selected_run: Some(self.root_run.clone()),
            sessions: vec![PersistedSessionSummary {
                id: self.session_id.clone(),
                name: Some("ACP session".to_owned()),
                session_file: None,
                cwd: None,
                root_run_id: Some(self.root_run.clone()),
                updated_at: None,
            }],
            runs: vec![self.run.clone()],
            objectives: Vec::new(),
        }
    }

    fn require_root_run(&self, run_id: &RunId) -> Result<(), BackendError> {
        if run_id == &self.root_run {
            Ok(())
        } else {
            Err(BackendError::InvalidConfiguration(format!(
                "run {run_id} is not owned by this ACP session"
            )))
        }
    }

    fn begin_prompt(
        &mut self,
        text: String,
        outputs: &BackendOutputSender,
    ) -> Result<(), BackendError> {
        self.turn_sequence = self
            .turn_sequence
            .checked_add(1)
            .ok_or_else(|| BackendError::Protocol("transcript sequence exhausted".to_owned()))?;
        self.prompt_active = true;
        self.assistant_text.clear();
        self.assistant_block_id = Some(format!("acp-assistant-{}", self.turn_sequence));
        self.run.state = RunState::Running;
        self.run.outcome = None;
        outputs.event(BackendEvent::TranscriptAppended(TranscriptBlock {
            id: format!("acp-user-{}", self.turn_sequence),
            run_id: self.root_run.clone(),
            role: TranscriptRole::User,
            text,
            complete: true,
        }))?;
        outputs.event(BackendEvent::RunChanged(self.run.clone()))?;
        Ok(())
    }

    fn append_assistant_text(
        &mut self,
        text: &str,
        outputs: &BackendOutputSender,
    ) -> Result<(), BackendError> {
        let first = self.assistant_text.is_empty();
        self.assistant_text.push_str(text);
        let block = TranscriptBlock {
            id: self
                .assistant_block_id
                .clone()
                .ok_or_else(|| BackendError::Protocol("assistant block is missing".to_owned()))?,
            run_id: self.root_run.clone(),
            role: TranscriptRole::Assistant,
            text: self.assistant_text.clone(),
            complete: false,
        };
        if first {
            outputs.event(BackendEvent::TranscriptAppended(block))?;
        } else {
            outputs.event(BackendEvent::TranscriptUpdated(block))?;
        }
        Ok(())
    }

    fn finish_prompt(
        &mut self,
        reason: StopReason,
        outputs: &BackendOutputSender,
    ) -> Result<(), BackendError> {
        self.prompt_active = false;
        if let Some(id) = self.assistant_block_id.take() {
            outputs.event(BackendEvent::TranscriptUpdated(TranscriptBlock {
                id,
                run_id: self.root_run.clone(),
                role: TranscriptRole::Assistant,
                text: self.assistant_text.clone(),
                complete: true,
            }))?;
        }
        match reason {
            StopReason::Cancelled => {
                self.run.state = RunState::Cancelled;
                self.run.outcome = Some(RunOutcome::Cancelled {
                    reason: "ACP session cancelled".to_owned(),
                });
            }
            StopReason::Refusal => {
                self.run.state = RunState::Failed;
                self.run.outcome = Some(RunOutcome::Failure {
                    code: "acp.refusal".to_owned(),
                    message: "ACP agent refused the prompt".to_owned(),
                    retryable: false,
                });
            }
            _ => {
                self.run.state = RunState::Completed;
                self.run.outcome = Some(RunOutcome::Success);
            }
        }
        outputs.event(BackendEvent::RunChanged(self.run.clone()))?;
        Ok(())
    }
}

fn command_name(command: &BackendCommand) -> &'static str {
    match command {
        BackendCommand::Initialize { .. } => "initialize",
        BackendCommand::SnapshotRequest => "snapshot",
        BackendCommand::PromptSubmit { .. } => "prompt.submit",
        BackendCommand::PromptSteer { .. } => "prompt.steer",
        BackendCommand::PromptFollowUp { .. } => "prompt.follow_up",
        BackendCommand::ExecutionAbort { .. } => "execution.abort",
        BackendCommand::SessionCreate { .. } => "session.create",
        BackendCommand::SessionSwitch { .. } => "session.switch",
        BackendCommand::SessionFork { .. } => "session.fork",
        BackendCommand::SessionClone { .. } => "session.clone",
        BackendCommand::SessionRename { .. } => "session.rename",
        BackendCommand::SessionList => "session.list",
        BackendCommand::SessionTree { .. } => "session.tree",
        BackendCommand::SessionExport { .. } => "session.export",
        BackendCommand::ModelList => "model.list",
        BackendCommand::ModelSelect { .. } => "model.select",
        BackendCommand::ThinkingLevels { .. } => "thinking.levels",
        BackendCommand::ThinkingSelect { .. } => "thinking.select",
        BackendCommand::AuthProviders => "auth.providers",
        BackendCommand::AuthLoginStart { .. } => "auth.login.start",
        BackendCommand::AuthLoginRespond { .. } => "auth.login.respond",
        BackendCommand::AuthLoginCancel { .. } => "auth.login.cancel",
        BackendCommand::AuthLogout { .. } => "auth.logout",
        BackendCommand::CompactionStart { .. } => "compaction.start",
        BackendCommand::CompactionAbort { .. } => "compaction.abort",
        BackendCommand::RetryConfigure { .. } => "retry.configure",
        BackendCommand::RetryAbort { .. } => "retry.abort",
        BackendCommand::CommandList => "command.list",
        BackendCommand::CommandInvoke { .. } => "command.invoke",
        BackendCommand::ResourceReload => "resource.reload",
        BackendCommand::ExtensionUiRespond { .. } => "extension_ui.respond",
        BackendCommand::Shutdown => "shutdown",
    }
}

fn to_acp_error(error: BackendError) -> agent_client_protocol::Error {
    agent_client_protocol::Error::internal_error().data(error.to_string())
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
    fn unsupported_commands_have_stable_semantic_names() {
        assert_eq!(command_name(&BackendCommand::ModelList), "model.list");
        assert_eq!(
            command_name(&BackendCommand::AuthProviders),
            "auth.providers"
        );
    }
}
