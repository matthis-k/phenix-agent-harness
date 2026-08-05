use crate::{AcpAgentBackend, AcpBackendConfig};
use phenix_acp::{
    AcpSession, AcpSessionFactory, AcpSessionId, GatewayError, ModelSelection, SessionCommand,
    SessionEvent, SessionImage, SessionOpenKind, SessionOpenRequest, SessionTreeId,
};
use phenix_runtime_api::{
    BackendCommand, BackendEvent, BackendHealth, BackendOutput, BackendReply, BackendRuntime,
    ClientInformation, ExtensionUiRequest, ImageInput, ModelRef, NotificationLevel, RunId,
    RunOutcome, RunState, RuntimeSnapshot, SessionId, ThinkingLevel, ToolExecutionOutcome,
    TranscriptBlock, TranscriptRole,
};
use std::collections::{BTreeMap, VecDeque};
use std::sync::mpsc::TryRecvError;
use std::sync::{Arc, Mutex};

impl AcpAgentBackend {
    pub fn gateway_factory(
        config: AcpBackendConfig,
        channel_capacity: usize,
    ) -> impl AcpSessionFactory {
        GatewaySessionFactory {
            config,
            channel_capacity,
            trees: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
}

#[derive(Clone)]
struct GatewaySessionFactory {
    config: AcpBackendConfig,
    channel_capacity: usize,
    trees: TreeRegistry,
}

type TreeRegistry = Arc<Mutex<BTreeMap<SessionTreeId, Arc<Mutex<TreeConnection>>>>>;

impl AcpSessionFactory for GatewaySessionFactory {
    fn open(&self, request: SessionOpenRequest) -> Result<Box<dyn AcpSession>, GatewayError> {
        if self.channel_capacity == 0 {
            return Err(GatewayError::session(
                "ACP gateway channel capacity must be positive",
            ));
        }
        let (connection, created) = {
            let mut trees = self
                .trees
                .lock()
                .map_err(|_| GatewayError::session("ACP tree registry lock poisoned"))?;
            if let Some(connection) = trees.get(&request.tree_id) {
                (Arc::clone(connection), false)
            } else {
                let connection = Arc::new(Mutex::new(TreeConnection::start(
                    self.config.clone(),
                    self.channel_capacity,
                )?));
                trees.insert(request.tree_id.clone(), Arc::clone(&connection));
                (connection, true)
            }
        };

        let binding = {
            let mut connection_guard = connection
                .lock()
                .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?;
            let binding = connection_guard.open(&request, created)?;
            if let Some(model) = &request.model {
                connection_guard.submit(BackendCommand::ModelSelect {
                    run_id: binding.run_id.clone(),
                    model: runtime_model(model),
                })?;
            }
            binding
        };

        Ok(Box::new(GatewayAcpSession {
            id: binding.acp_id,
            session_id: binding.session_id,
            run_id: binding.run_id,
            tree_id: request.tree_id,
            connection,
            registry: Arc::clone(&self.trees),
            closed: false,
        }))
    }
}

struct GatewayAcpSession {
    id: AcpSessionId,
    session_id: SessionId,
    run_id: RunId,
    tree_id: SessionTreeId,
    connection: Arc<Mutex<TreeConnection>>,
    registry: TreeRegistry,
    closed: bool,
}

impl GatewayAcpSession {
    fn close(&mut self) -> Result<(), GatewayError> {
        if self.closed {
            return Ok(());
        }
        self.closed = true;
        let remove_tree = {
            let mut connection = self
                .connection
                .lock()
                .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?;
            connection.release(&self.session_id)?
        };
        if remove_tree {
            let mut trees = self
                .registry
                .lock()
                .map_err(|_| GatewayError::session("ACP tree registry lock poisoned"))?;
            if trees
                .get(&self.tree_id)
                .is_some_and(|connection| Arc::ptr_eq(connection, &self.connection))
            {
                trees.remove(&self.tree_id);
            }
        }
        Ok(())
    }
}

impl AcpSession for GatewayAcpSession {
    fn id(&self) -> &AcpSessionId {
        &self.id
    }

    fn execute(&mut self, command: SessionCommand) -> Result<Vec<SessionEvent>, GatewayError> {
        if matches!(command, SessionCommand::Close) {
            self.close()?;
            return Ok(Vec::new());
        }
        if self.closed {
            return Err(GatewayError::session(format!(
                "ACP session {} is closed",
                self.id
            )));
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| GatewayError::session("ACP tree connection lock poisoned"))?;
        match command {
            SessionCommand::Prompt { text, images } => {
                connection.submit(BackendCommand::PromptSubmit {
                    run_id: self.run_id.clone(),
                    text,
                    images: runtime_images(images),
                    streaming_behavior: None,
                })?;
            }
            SessionCommand::Steer { text, images } => {
                connection.submit(BackendCommand::PromptSteer {
                    run_id: self.run_id.clone(),
                    text,
                    images: runtime_images(images),
                })?;
            }
            SessionCommand::FollowUp { text, images } => {
                connection.submit(BackendCommand::PromptFollowUp {
                    run_id: self.run_id.clone(),
                    text,
                    images: runtime_images(images),
                })?;
            }
            SessionCommand::Compact { instructions } => {
                connection.submit(BackendCommand::CompactionStart {
                    run_id: self.run_id.clone(),
                    instructions,
                })?;
            }
            SessionCommand::Poll => connection.drain_available()?,
            SessionCommand::Cancel => {
                connection.submit(BackendCommand::ExecutionAbort {
                    run_id: Some(self.run_id.clone()),
                })?;
            }
            SessionCommand::Rename { name } => {
                connection.submit(BackendCommand::SessionRename {
                    session_id: self.session_id.clone(),
                    name,
                })?;
            }
            SessionCommand::SetModel { model } => {
                connection.submit(BackendCommand::ModelSelect {
                    run_id: self.run_id.clone(),
                    model: runtime_model(&model),
                })?;
            }
            SessionCommand::SetMode { mode_id } => {
                connection.submit(BackendCommand::SessionModeSelect {
                    run_id: self.run_id.clone(),
                    mode_id,
                })?;
            }
            SessionCommand::SetThinking { level } => {
                connection.submit(BackendCommand::ThinkingSelect {
                    run_id: self.run_id.clone(),
                    level: parse_thinking_level(&level)?,
                })?;
            }
            SessionCommand::Invoke { name, arguments } => {
                connection.submit(BackendCommand::CommandInvoke {
                    run_id: self.run_id.clone(),
                    name,
                    arguments,
                })?;
            }
            SessionCommand::Close => unreachable!("close handled before connection lock"),
        }
        connection.drain_events(&self.run_id)
    }
}

impl Drop for GatewayAcpSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

struct SessionBinding {
    acp_id: AcpSessionId,
    session_id: SessionId,
    run_id: RunId,
}

struct TreeConnection {
    runtime: Option<BackendRuntime>,
    snapshot: RuntimeSnapshot,
    sessions: BTreeMap<SessionId, RunId>,
    pending: BTreeMap<RunId, VecDeque<SessionEvent>>,
    transcript_lengths: BTreeMap<String, usize>,
    stopped: bool,
}

impl TreeConnection {
    fn start(config: AcpBackendConfig, channel_capacity: usize) -> Result<Self, GatewayError> {
        let runtime = BackendRuntime::spawn(
            Box::new(AcpAgentBackend::new(config)),
            channel_capacity,
        )
        .map_err(backend_error)?;
        let mut connection = Self {
            runtime: Some(runtime),
            snapshot: empty_snapshot(),
            sessions: BTreeMap::new(),
            pending: BTreeMap::new(),
            transcript_lengths: BTreeMap::new(),
            stopped: false,
        };
        match connection.submit(BackendCommand::Initialize {
            client: ClientInformation {
                name: "phenix-acp-gateway".to_owned(),
                build: env!("CARGO_PKG_VERSION").to_owned(),
            },
        })? {
            BackendReply::Initialized { snapshot, .. } => connection.snapshot = snapshot,
            reply => {
                return Err(GatewayError::session(format!(
                    "ACP backend returned {reply:?} during initialization"
                )))
            }
        }
        Ok(connection)
    }

    fn open(
        &mut self,
        request: &SessionOpenRequest,
        connection_created: bool,
    ) -> Result<SessionBinding, GatewayError> {
        let reuse_initialized = connection_created
            && matches!(request.open, SessionOpenKind::New { parent: None });
        if !reuse_initialized {
            let command = match &request.open {
                SessionOpenKind::New { parent } => BackendCommand::SessionCreate {
                    parent_session: parent.as_ref().map(runtime_session_id).transpose()?,
                },
                SessionOpenKind::Load { session_id }
                | SessionOpenKind::Resume { session_id } => BackendCommand::SessionSwitch {
                    session_id: runtime_session_id(session_id)?,
                },
                SessionOpenKind::Fork { session_id } => BackendCommand::SessionClone {
                    session_id: runtime_session_id(session_id)?,
                },
            };
            self.submit(command)?;
        }
        let binding = self.active_binding()?;
        if self.sessions.contains_key(&binding.session_id) {
            return Err(GatewayError::session(format!(
                "ACP session {} is already attached to this tree",
                binding.acp_id
            )));
        }
        self.sessions
            .insert(binding.session_id.clone(), binding.run_id.clone());
        self.pending.entry(binding.run_id.clone()).or_default();
        Ok(binding)
    }

    fn active_binding(&self) -> Result<SessionBinding, GatewayError> {
        let session_id = self.snapshot.active_session.clone().ok_or_else(|| {
            GatewayError::session(
                "ACP backend did not provide an active session; authentication may be required",
            )
        })?;
        let run_id = self
            .snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .and_then(|session| session.root_run_id.clone())
            .or_else(|| {
                self.snapshot
                    .runs
                    .iter()
                    .find(|run| run.persisted_session.as_ref() == Some(&session_id))
                    .map(|run| run.id.clone())
            })
            .ok_or_else(|| {
                GatewayError::session(format!(
                    "ACP session {session_id} has no projected Phenix run"
                ))
            })?;
        let acp_id = AcpSessionId::parse(session_id.as_str())
            .map_err(|error| GatewayError::session(error.to_string()))?;
        Ok(SessionBinding {
            acp_id,
            session_id,
            run_id,
        })
    }

    fn submit(&mut self, command: BackendCommand) -> Result<BackendReply, GatewayError> {
        if self.stopped {
            return Err(GatewayError::session("ACP backend has stopped"));
        }
        let request_id = self
            .runtime
            .as_ref()
            .ok_or_else(|| GatewayError::session("ACP backend runtime is unavailable"))?
            .client
            .submit(command)
            .map_err(backend_error)?;
        loop {
            let output = self
                .runtime
                .as_ref()
                .ok_or_else(|| GatewayError::session("ACP backend runtime is unavailable"))?
                .outputs
                .recv()
                .map_err(|_| GatewayError::session("ACP backend output channel closed"))?;
            match output {
                BackendOutput::Reply {
                    request_id: reply_id,
                    result,
                } if reply_id == request_id => {
                    let reply = result.map_err(backend_error)?;
                    self.apply_reply(&reply);
                    self.drain_available()?;
                    return Ok(reply);
                }
                BackendOutput::Reply {
                    request_id: reply_id,
                    ..
                } => {
                    return Err(GatewayError::session(format!(
                        "ACP backend replied to unexpected request {reply_id}"
                    )))
                }
                BackendOutput::Event(event) => self.dispatch(event)?,
                BackendOutput::Stopped { result } => {
                    self.stopped = true;
                    result.map_err(backend_error)?;
                    return Err(GatewayError::session(
                        "ACP backend stopped before replying",
                    ));
                }
            }
        }
    }

    fn apply_reply(&mut self, reply: &BackendReply) {
        match reply {
            BackendReply::Initialized { snapshot, .. } | BackendReply::Snapshot(snapshot) => {
                self.snapshot = snapshot.clone();
            }
            BackendReply::Accepted
            | BackendReply::Sessions(_)
            | BackendReply::Runs(_)
            | BackendReply::SessionTree(_)
            | BackendReply::SessionModes(_)
            | BackendReply::Models(_)
            | BackendReply::ThinkingLevels(_)
            | BackendReply::AuthProviders(_)
            | BackendReply::Commands(_)
            | BackendReply::Exported { .. }
            | BackendReply::Completed => {}
        }
    }

    fn drain_available(&mut self) -> Result<(), GatewayError> {
        loop {
            let output = match self
                .runtime
                .as_ref()
                .ok_or_else(|| GatewayError::session("ACP backend runtime is unavailable"))?
                .outputs
                .try_recv()
            {
                Ok(output) => output,
                Err(TryRecvError::Empty) => return Ok(()),
                Err(TryRecvError::Disconnected) => {
                    self.stopped = true;
                    return Err(GatewayError::session(
                        "ACP backend output channel disconnected",
                    ));
                }
            };
            match output {
                BackendOutput::Event(event) => self.dispatch(event)?,
                BackendOutput::Stopped { result } => {
                    self.stopped = true;
                    result.map_err(backend_error)?;
                }
                BackendOutput::Reply { request_id, .. } => {
                    return Err(GatewayError::session(format!(
                        "ACP backend produced an unclaimed reply for {request_id}"
                    )))
                }
            }
        }
    }

    fn dispatch(&mut self, event: BackendEvent) -> Result<(), GatewayError> {
        match event {
            BackendEvent::SnapshotChanged(snapshot) => self.snapshot = snapshot,
            BackendEvent::PersistedSessionChanged(summary) => {
                if let Some(existing) = self
                    .snapshot
                    .sessions
                    .iter_mut()
                    .find(|session| session.id == summary.id)
                {
                    *existing = summary;
                } else {
                    self.snapshot.sessions.push(summary);
                }
            }
            BackendEvent::RunChanged(run) => {
                if let Some(existing) = self
                    .snapshot
                    .runs
                    .iter_mut()
                    .find(|candidate| candidate.id == run.id)
                {
                    *existing = run.clone();
                } else {
                    self.snapshot.runs.push(run.clone());
                }
                if let Some(event) = terminal_run_event(&run.state, run.outcome.as_ref()) {
                    self.push(run.id, event);
                }
            }
            BackendEvent::ObjectiveChanged(_) => {}
            BackendEvent::TranscriptAppended(block) => {
                if let Some(event) = self.transcript_event(&block, false) {
                    self.push(block.run_id, event);
                }
            }
            BackendEvent::TranscriptUpdated(block) => {
                if let Some(event) = self.transcript_event(&block, true) {
                    self.push(block.run_id, event);
                }
            }
            BackendEvent::ToolStarted {
                run_id,
                tool_call_id,
                tool_name,
                input_summary,
            } => self.push(
                run_id,
                SessionEvent::ToolStarted {
                    call_id: tool_call_id.to_string(),
                    name: tool_name,
                    input_summary,
                },
            ),
            BackendEvent::ToolUpdated {
                run_id,
                tool_call_id,
                output,
            } => self.push(
                run_id,
                SessionEvent::ToolUpdated {
                    call_id: tool_call_id.to_string(),
                    output,
                },
            ),
            BackendEvent::ToolFinished {
                run_id,
                tool_call_id,
                outcome,
                output_summary,
            } => self.push(
                run_id,
                SessionEvent::ToolFinished {
                    call_id: tool_call_id.to_string(),
                    succeeded: matches!(outcome, ToolExecutionOutcome::Succeeded),
                    output_summary,
                },
            ),
            BackendEvent::QueueChanged {
                run_id,
                steering,
                follow_ups,
            } => self.push(
                run_id,
                SessionEvent::QueueChanged {
                    steering,
                    follow_ups,
                },
            ),
            BackendEvent::ExtensionUiRequested { dialog_id, request } => {
                let event = interaction_event(dialog_id.to_string(), request);
                self.push_active(event);
            }
            BackendEvent::StatusChanged { key, text } if key.starts_with("terminal.") => {
                self.push_active(SessionEvent::Terminal {
                    terminal_id: key.trim_start_matches("terminal.").to_owned(),
                    output: text.unwrap_or_default(),
                    exit_code: None,
                });
            }
            BackendEvent::Notification { level, message } => {
                self.push_active(match level {
                    NotificationLevel::Error => SessionEvent::Failed { message },
                    NotificationLevel::Information | NotificationLevel::Warning => {
                        SessionEvent::Text { text: message }
                    }
                });
            }
            BackendEvent::HealthChanged(BackendHealth::Failed { message }) => {
                self.push_active(SessionEvent::Failed { message });
            }
            BackendEvent::HealthChanged(BackendHealth::Degraded { message }) => {
                self.push_active(SessionEvent::Text { text: message });
            }
            BackendEvent::AuthFinished { result, .. } => match result {
                Ok(()) => self.push_active(SessionEvent::Text {
                    text: "authentication completed".to_owned(),
                }),
                Err(message) => self.push_active(SessionEvent::Failed { message }),
            },
            BackendEvent::ExternalCommandRequested { command, .. } => {
                self.push_active(SessionEvent::Text {
                    text: format!(
                        "authentication requires external command: {} {}",
                        command.program,
                        command.arguments.join(" ")
                    ),
                });
            }
            BackendEvent::AuthPromptRequested { prompt, .. } => {
                self.push_active(SessionEvent::Text {
                    text: format!("authentication input required: {prompt:?}"),
                });
            }
            BackendEvent::AuthNotice { notice, .. } => {
                self.push_active(SessionEvent::Text {
                    text: format!("authentication: {notice:?}"),
                });
            }
            BackendEvent::StatusChanged { key, text } => {
                self.push_active(SessionEvent::Text {
                    text: text.map_or(key.clone(), |text| format!("{key}: {text}")),
                });
            }
            BackendEvent::HealthChanged(BackendHealth::Starting) => {}
            BackendEvent::HealthChanged(BackendHealth::Ready) => {}
            BackendEvent::HealthChanged(BackendHealth::Stopped) => {
                self.push_active(SessionEvent::Failed {
                    message: "ACP backend stopped".to_owned(),
                });
            }
        }
        Ok(())
    }

    fn transcript_event(&mut self, block: &TranscriptBlock, updated: bool) -> Option<SessionEvent> {
        let previous = self
            .transcript_lengths
            .insert(block.id.clone(), block.text.len())
            .unwrap_or(0);
        let text = if updated && previous <= block.text.len() && block.text.is_char_boundary(previous)
        {
            block.text[previous..].to_owned()
        } else {
            block.text.clone()
        };
        if text.is_empty() {
            return None;
        }
        match block.role {
            TranscriptRole::Thinking => Some(SessionEvent::Thought { text }),
            TranscriptRole::User => None,
            TranscriptRole::Assistant | TranscriptRole::Tool | TranscriptRole::System => {
                Some(SessionEvent::Text { text })
            }
        }
    }

    fn push(&mut self, run_id: RunId, event: SessionEvent) {
        self.pending.entry(run_id).or_default().push_back(event);
    }

    fn push_active(&mut self, event: SessionEvent) {
        if let Some(run_id) = self.snapshot.selected_run.clone().or_else(|| {
            self.snapshot
                .active_session
                .as_ref()
                .and_then(|session_id| self.sessions.get(session_id))
                .cloned()
        }) {
            self.push(run_id, event);
        }
    }

    fn drain_events(&mut self, run_id: &RunId) -> Result<Vec<SessionEvent>, GatewayError> {
        self.drain_available()?;
        Ok(self
            .pending
            .entry(run_id.clone())
            .or_default()
            .drain(..)
            .collect())
    }

    fn release(&mut self, session_id: &SessionId) -> Result<bool, GatewayError> {
        let Some(run_id) = self.sessions.remove(session_id) else {
            return Ok(self.sessions.is_empty());
        };
        self.pending.remove(&run_id);
        if !self.sessions.is_empty() {
            return Ok(false);
        }
        if !self.stopped {
            let _ = self.submit(BackendCommand::Shutdown)?;
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.join().map_err(backend_error)?;
        }
        Ok(true)
    }
}

fn runtime_images(images: Vec<SessionImage>) -> Vec<ImageInput> {
    images
        .into_iter()
        .map(|image| ImageInput {
            media_type: image.media_type,
            bytes: image.data,
        })
        .collect()
}

fn runtime_model(model: &ModelSelection) -> ModelRef {
    ModelRef {
        provider: model.provider.as_str().to_owned(),
        model: model.model.as_str().to_owned(),
    }
}

fn runtime_session_id(session_id: &AcpSessionId) -> Result<SessionId, GatewayError> {
    SessionId::parse(session_id.as_str()).map_err(|error| GatewayError::session(error.to_string()))
}

fn parse_thinking_level(level: &str) -> Result<ThinkingLevel, GatewayError> {
    match level.trim().to_ascii_lowercase().replace('-', "_").as_str() {
        "off" => Ok(ThinkingLevel::Off),
        "minimal" => Ok(ThinkingLevel::Minimal),
        "low" => Ok(ThinkingLevel::Low),
        "medium" => Ok(ThinkingLevel::Medium),
        "high" => Ok(ThinkingLevel::High),
        "extra_high" | "xhigh" => Ok(ThinkingLevel::ExtraHigh),
        "max" => Ok(ThinkingLevel::Max),
        other => Err(GatewayError::session(format!(
            "unknown thinking level {other}"
        ))),
    }
}

fn terminal_run_event(state: &RunState, outcome: Option<&RunOutcome>) -> Option<SessionEvent> {
    match state {
        RunState::Completed => Some(SessionEvent::Completed),
        RunState::Failed => Some(SessionEvent::Failed {
            message: match outcome {
                Some(RunOutcome::Failure { message, .. }) => message.clone(),
                _ => "ACP run failed".to_owned(),
            },
        }),
        RunState::Cancelled => Some(SessionEvent::Cancelled {
            reason: match outcome {
                Some(RunOutcome::Cancelled { reason }) => reason.clone(),
                _ => "ACP run cancelled".to_owned(),
            },
        }),
        RunState::Created
        | RunState::Starting
        | RunState::Running
        | RunState::Waiting
        | RunState::Completing
        | RunState::Orphaned => None,
    }
}

fn interaction_event(request_id: String, request: ExtensionUiRequest) -> SessionEvent {
    match request {
        ExtensionUiRequest::Select { title, options } => SessionEvent::PermissionRequested {
            request_id,
            title,
            options,
        },
        ExtensionUiRequest::Confirm { title, message } => SessionEvent::PermissionRequested {
            request_id,
            title: format!("{title}: {message}"),
            options: vec!["Confirm".to_owned(), "Cancel".to_owned()],
        },
        ExtensionUiRequest::Input {
            title,
            placeholder,
            secret,
        } => SessionEvent::Text {
            text: format!(
                "{title}: input required{}{}",
                if secret { " (secret)" } else { "" },
                placeholder.map_or_else(String::new, |value| format!(" [{value}]"))
            ),
        },
        ExtensionUiRequest::Editor { title, .. } => SessionEvent::Text {
            text: format!("{title}: editor input required"),
        },
    }
}

fn empty_snapshot() -> RuntimeSnapshot {
    RuntimeSnapshot {
        capabilities: Default::default(),
        health: BackendHealth::Starting,
        active_session: None,
        root_run: None,
        selected_run: None,
        sessions: Vec::new(),
        runs: Vec::new(),
        objectives: Vec::new(),
    }
}

fn backend_error(error: phenix_runtime_api::BackendError) -> GatewayError {
    GatewayError::session(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thinking_levels_are_parsed_without_backend_specific_strings_leaking_out() {
        assert_eq!(
            parse_thinking_level("extra-high").expect("level"),
            ThinkingLevel::ExtraHigh
        );
        assert!(parse_thinking_level("unbounded").is_err());
    }

    #[test]
    fn terminal_run_outcomes_preserve_failure_and_cancellation_details() {
        assert_eq!(
            terminal_run_event(
                &RunState::Failed,
                Some(&RunOutcome::Failure {
                    code: "test".to_owned(),
                    message: "failed deliberately".to_owned(),
                    retryable: false,
                })
            ),
            Some(SessionEvent::Failed {
                message: "failed deliberately".to_owned()
            })
        );
        assert_eq!(
            terminal_run_event(
                &RunState::Cancelled,
                Some(&RunOutcome::Cancelled {
                    reason: "stopped".to_owned(),
                })
            ),
            Some(SessionEvent::Cancelled {
                reason: "stopped".to_owned()
            })
        );
    }
}
