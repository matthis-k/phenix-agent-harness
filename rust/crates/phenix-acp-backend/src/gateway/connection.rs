use super::projection::{
    backend_error, empty_snapshot, interaction_event, runtime_session_id, terminal_run_event,
};
use crate::{AcpAgentBackend, AcpBackendConfig};
use phenix_acp::{AcpSessionId, GatewayError, SessionEvent, SessionOpenKind, SessionOpenRequest};
use phenix_runtime_api::{
    BackendCommand, BackendEvent, BackendHealth, BackendOutput, BackendReply, BackendRuntime,
    ClientInformation, NotificationLevel, RequestId, RunId, RuntimeSnapshot, SessionId,
    ToolExecutionOutcome, TranscriptBlock, TranscriptRole,
};
use std::collections::{BTreeMap, VecDeque};
use std::sync::mpsc::{RecvTimeoutError, TryRecvError};
use std::time::Duration;

const BACKEND_REPLY_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct SessionBinding {
    pub(super) acp_id: AcpSessionId,
    pub(super) session_id: SessionId,
    pub(super) run_id: RunId,
}

pub(super) struct TreeConnection {
    runtime: Option<BackendRuntime>,
    snapshot: RuntimeSnapshot,
    sessions: BTreeMap<SessionId, RunId>,
    pending: BTreeMap<RunId, VecDeque<SessionEvent>>,
    deferred_replies: BTreeMap<RequestId, RunId>,
    control_events: VecDeque<BackendEvent>,
    transcript_lengths: BTreeMap<(RunId, String), usize>,
    controls: usize,
    stopped: bool,
}

impl TreeConnection {
    pub(super) fn start(
        config: AcpBackendConfig,
        channel_capacity: usize,
    ) -> Result<Self, GatewayError> {
        let runtime =
            BackendRuntime::spawn(Box::new(AcpAgentBackend::new(config)), channel_capacity)
                .map_err(backend_error)?;
        let mut connection = Self::from_runtime(runtime);
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

    fn from_runtime(runtime: BackendRuntime) -> Self {
        Self {
            runtime: Some(runtime),
            snapshot: empty_snapshot(),
            sessions: BTreeMap::new(),
            pending: BTreeMap::new(),
            deferred_replies: BTreeMap::new(),
            control_events: VecDeque::new(),
            transcript_lengths: BTreeMap::new(),
            controls: 0,
            stopped: false,
        }
    }

    pub(super) fn open(
        &mut self,
        request: &SessionOpenRequest,
        _connection_created: bool,
    ) -> Result<SessionBinding, GatewayError> {
        let reuse_initialized = matches!(&request.open, SessionOpenKind::New { parent: None })
            && self.sessions.is_empty()
            && self.snapshot.active_session.is_some();
        if !reuse_initialized {
            let command = match &request.open {
                SessionOpenKind::New { parent } => BackendCommand::SessionCreate {
                    parent_session: parent.as_ref().map(runtime_session_id).transpose()?,
                },
                SessionOpenKind::Load { session_id } | SessionOpenKind::Resume { session_id } => {
                    BackendCommand::SessionSwitch {
                        session_id: runtime_session_id(session_id)?,
                    }
                }
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

    pub(super) fn submit(&mut self, command: BackendCommand) -> Result<BackendReply, GatewayError> {
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
                .recv_timeout(BACKEND_REPLY_TIMEOUT)
                .map_err(|error| match error {
                    RecvTimeoutError::Timeout => GatewayError::session(format!(
                        "ACP backend did not acknowledge request {request_id} within {} seconds",
                        BACKEND_REPLY_TIMEOUT.as_secs()
                    )),
                    RecvTimeoutError::Disconnected => {
                        GatewayError::session("ACP backend output channel closed")
                    }
                })?;
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
                    result,
                } => {
                    if self.deferred_replies.remove(&reply_id).is_none() {
                        return Err(GatewayError::session(format!(
                            "ACP backend replied to unexpected request {reply_id}"
                        )));
                    }
                    let reply = result.map_err(backend_error)?;
                    self.apply_reply(&reply);
                }
                BackendOutput::Event(event) => self.dispatch(event)?,
                BackendOutput::Stopped { result } => {
                    self.stopped = true;
                    result.map_err(backend_error)?;
                    return Err(GatewayError::session("ACP backend stopped before replying"));
                }
            }
        }
    }

    /// Queue an acknowledgement-only backend command without waiting for its reply.
    ///
    /// Prompt, steering, follow-up, and cancellation commands are long-lived at
    /// the ACP layer even though the runtime acknowledgement should be immediate.
    /// Keeping their acknowledgement asynchronous prevents one damaged backend
    /// request from monopolizing the tree mutex and blocking cancellation/control.
    pub(super) fn submit_deferred(
        &mut self,
        run_id: &RunId,
        command: BackendCommand,
    ) -> Result<(), GatewayError> {
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
        if self
            .deferred_replies
            .insert(request_id.clone(), run_id.clone())
            .is_some()
        {
            return Err(GatewayError::session(format!(
                "duplicate deferred ACP backend request {request_id}"
            )));
        }
        Ok(())
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

    pub(super) fn drain_available(&mut self) -> Result<(), GatewayError> {
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
                Err(TryRecvError::Disconnected) if self.stopped => return Ok(()),
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
                    return Ok(());
                }
                BackendOutput::Reply { request_id, result } => {
                    if self.deferred_replies.remove(&request_id).is_none() {
                        return Err(GatewayError::session(format!(
                            "ACP backend produced an unclaimed reply for {request_id}"
                        )));
                    }
                    let reply = result.map_err(backend_error)?;
                    self.apply_reply(&reply);
                }
            }
        }
    }

    fn dispatch(&mut self, event: BackendEvent) -> Result<(), GatewayError> {
        if matches!(
            &event,
            BackendEvent::ExternalCommandRequested { .. }
                | BackendEvent::AuthPromptRequested { .. }
                | BackendEvent::AuthNotice { .. }
                | BackendEvent::AuthFinished { .. }
                | BackendEvent::HealthChanged(_)
        ) {
            self.control_events.push_back(event.clone());
        }
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
                raw_input_json,
                input_summary,
            } => self.push(
                run_id,
                SessionEvent::ToolStarted {
                    call_id: tool_call_id.to_string(),
                    name: tool_name,
                    raw_input_json,
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
                self.push_active(interaction_event(dialog_id.to_string(), request));
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
            .insert((block.run_id.clone(), block.id.clone()), block.text.len())
            .unwrap_or(0);
        let text =
            if updated && previous <= block.text.len() && block.text.is_char_boundary(previous) {
                block.text[previous..].to_owned()
            } else {
                block.text.clone()
            };
        if text.is_empty() {
            return None;
        }
        match &block.role {
            TranscriptRole::Thinking => Some(SessionEvent::Thought { text }),
            TranscriptRole::User => None,
            TranscriptRole::Assistant | TranscriptRole::Tool | TranscriptRole::System => {
                Some(SessionEvent::Text { text })
            }
        }
    }

    pub(super) fn push(&mut self, run_id: RunId, event: SessionEvent) {
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

    pub(super) fn drain_events(
        &mut self,
        run_id: &RunId,
    ) -> Result<Vec<SessionEvent>, GatewayError> {
        self.drain_available()?;
        Ok(self
            .pending
            .entry(run_id.clone())
            .or_default()
            .drain(..)
            .collect())
    }

    pub(super) fn snapshot(&self) -> RuntimeSnapshot {
        self.snapshot.clone()
    }

    pub(super) fn retain_control(&mut self) -> Result<(), GatewayError> {
        self.controls = self
            .controls
            .checked_add(1)
            .ok_or_else(|| GatewayError::session("ACP control leases exhausted"))?;
        Ok(())
    }

    pub(super) fn drain_control_events(&mut self) -> Result<Vec<BackendEvent>, GatewayError> {
        self.drain_available()?;
        Ok(self.control_events.drain(..).collect())
    }

    pub(super) fn release_control(&mut self) -> Result<bool, GatewayError> {
        if self.controls == 0 {
            return Err(GatewayError::session(
                "ACP control lease was already released",
            ));
        }
        self.controls -= 1;
        self.shutdown_if_unused()
    }

    pub(super) fn release(&mut self, session_id: &SessionId) -> Result<bool, GatewayError> {
        if let Some(run_id) = self.sessions.remove(session_id) {
            self.pending.remove(&run_id);
        }
        self.shutdown_if_unused()
    }

    fn shutdown_if_unused(&mut self) -> Result<bool, GatewayError> {
        if !self.sessions.is_empty() || self.controls != 0 {
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

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{
        AgentBackend, BackendError, BackendOutputSender, BackendRequest, StreamingBehavior,
    };
    use std::sync::mpsc::Receiver;

    struct MissingPromptAckBackend;

    impl AgentBackend for MissingPromptAckBackend {
        fn run(
            self: Box<Self>,
            requests: Receiver<BackendRequest>,
            outputs: BackendOutputSender,
        ) -> Result<(), BackendError> {
            for request in requests {
                match request.command {
                    BackendCommand::PromptSubmit { .. } => {
                        // Simulate a damaged adapter that accepted work but lost
                        // the acknowledgement. It must not prevent later control.
                    }
                    BackendCommand::SnapshotRequest => {
                        outputs.reply(request.id, Ok(BackendReply::Snapshot(empty_snapshot())))?;
                    }
                    BackendCommand::Shutdown => {
                        outputs.reply(request.id, Ok(BackendReply::Completed))?;
                        return Ok(());
                    }
                    _ => outputs.reply(request.id, Ok(BackendReply::Accepted))?,
                }
            }
            Ok(())
        }
    }

    #[test]
    fn missing_prompt_ack_does_not_block_later_control_requests() {
        let runtime = BackendRuntime::spawn(Box::new(MissingPromptAckBackend), 8)
            .expect("spawn missing-ack backend");
        let mut connection = TreeConnection::from_runtime(runtime);
        let run_id = RunId::parse("run-stall-test").expect("run id");

        connection
            .submit_deferred(
                &run_id,
                BackendCommand::PromptSubmit {
                    run_id: run_id.clone(),
                    text: "stall".to_owned(),
                    images: Vec::new(),
                    streaming_behavior: Some(StreamingBehavior::Steer),
                },
            )
            .expect("queue prompt without waiting for ack");
        connection
            .submit_deferred(
                &run_id,
                BackendCommand::ExecutionAbort {
                    run_id: Some(run_id.clone()),
                },
            )
            .expect("queue cancellation behind missing prompt ack");

        let reply = connection
            .submit(BackendCommand::SnapshotRequest)
            .expect("later control request remains responsive");
        assert!(matches!(reply, BackendReply::Snapshot(_)));
    }
}
