from __future__ import annotations

from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"expected one {label}, found {count}")
    return source.replace(old, new, 1)


def replace_between(source: str, start: str, end: str, replacement: str, label: str) -> str:
    start_index = source.find(start)
    if start_index < 0:
        raise SystemExit(f"missing start marker for {label}")
    end_index = source.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f"missing end marker for {label}")
    return source[:start_index] + replacement + source[end_index:]


# Preserve transcript semantics in the backend-neutral gateway model.
path = Path("rust/crates/phenix-acp/src/runtime/model.rs")
source = path.read_text()
source = replace_once(
    source,
    '''#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    Text {
''',
    '''#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionTranscriptRole {
    User,
    Assistant,
    Thinking,
    Tool,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    TranscriptAppended {
        id: String,
        role: SessionTranscriptRole,
        text: String,
        complete: bool,
    },
    TranscriptUpdated {
        id: String,
        role: SessionTranscriptRole,
        text: String,
        complete: bool,
    },
    Text {
''',
    "session transcript event model",
)
path.write_text(source)

# Ensure new transcript events participate in exhaustive gateway state handling.
path = Path("rust/crates/phenix-acp/src/runtime/gateway.rs")
source = path.read_text()
source = replace_once(
    source,
    '''                    super::SessionEvent::Text { .. }
                    | super::SessionEvent::Thought { .. }
''',
    '''                    super::SessionEvent::TranscriptAppended { .. }
                    | super::SessionEvent::TranscriptUpdated { .. }
                    | super::SessionEvent::Text { .. }
                    | super::SessionEvent::Thought { .. }
''',
    "gateway transcript exhaustive match",
)
path.write_text(source)

# Stop dropping user messages and stop converting stable transcript updates into anonymous deltas.
path = Path("rust/crates/phenix-acp-backend/src/gateway/connection.rs")
source = path.read_text()
source = replace_once(
    source,
    '''    AcpSession, AcpSessionFactory, AcpSessionId, GatewayError, SessionCommand, SessionEvent,
    SessionOpenRequest, SessionTreeId,
''',
    '''    AcpSession, AcpSessionFactory, AcpSessionId, GatewayError, SessionCommand, SessionEvent,
    SessionOpenRequest, SessionTranscriptRole, SessionTreeId,
''',
    "gateway connection import",
)
source = replace_once(
    source,
    '''    transcript_lengths: BTreeMap<(RunId, String), usize>,
''',
    "",
    "obsolete transcript delta state",
)
source = replace_once(
    source,
    '''            transcript_lengths: BTreeMap::new(),
''',
    "",
    "obsolete transcript delta initialization",
)
source = replace_once(
    source,
    '''            BackendEvent::TranscriptAppended(block) => {
                if let Some(event) = self.transcript_event(&block, false) {
                    self.push(block.run_id, event);
                }
            }
            BackendEvent::TranscriptUpdated(block) => {
                if let Some(event) = self.transcript_event(&block, true) {
                    self.push(block.run_id, event);
                }
            }
''',
    '''            BackendEvent::TranscriptAppended(block) => {
                let run_id = block.run_id.clone();
                self.push(run_id, Self::transcript_event(block, false));
            }
            BackendEvent::TranscriptUpdated(block) => {
                let run_id = block.run_id.clone();
                self.push(run_id, Self::transcript_event(block, true));
            }
''',
    "gateway transcript dispatch",
)
source = replace_between(
    source,
    "    fn transcript_event",
    "    pub(super) fn push",
    '''    fn transcript_event(block: TranscriptBlock, updated: bool) -> SessionEvent {
        let role = match block.role {
            TranscriptRole::User => SessionTranscriptRole::User,
            TranscriptRole::Assistant => SessionTranscriptRole::Assistant,
            TranscriptRole::Thinking => SessionTranscriptRole::Thinking,
            TranscriptRole::Tool => SessionTranscriptRole::Tool,
            TranscriptRole::System => SessionTranscriptRole::System,
        };
        if updated {
            SessionEvent::TranscriptUpdated {
                id: block.id,
                role,
                text: block.text,
                complete: block.complete,
            }
        } else {
            SessionEvent::TranscriptAppended {
                id: block.id,
                role,
                text: block.text,
                complete: block.complete,
            }
        }
    }

''',
    "gateway transcript conversion",
)
source += '''

#[cfg(test)]
mod transcript_tests {
    use super::*;

    #[test]
    fn transcript_projection_preserves_user_role_identity_and_update_semantics() {
        let run_id = RunId::parse("run-transcript").expect("run ID");
        let block = TranscriptBlock {
            id: "message-1".to_owned(),
            run_id,
            role: TranscriptRole::User,
            text: "hello".to_owned(),
            complete: true,
        };
        assert_eq!(
            TreeConnection::transcript_event(block.clone(), false),
            SessionEvent::TranscriptAppended {
                id: "message-1".to_owned(),
                role: SessionTranscriptRole::User,
                text: "hello".to_owned(),
                complete: true,
            }
        );
        assert_eq!(
            TreeConnection::transcript_event(block, true),
            SessionEvent::TranscriptUpdated {
                id: "message-1".to_owned(),
                role: SessionTranscriptRole::User,
                text: "hello".to_owned(),
                complete: true,
            }
        );
    }
}
'''
path.write_text(source)

# Reconstruct the exact transcript blocks for Ratatui and surface async failures.
path = Path("rust/crates/phenix-acp-backend/src/frontend/projection.rs")
source = path.read_text()
source = replace_once(
    source,
    '''    AcpSessionId, GatewayEvent, ObjectiveState as GatewayObjectiveState, SessionEvent,
    SessionNodeId, SessionNodeState, SessionTreeSnapshot,
''',
    '''    AcpSessionId, GatewayEvent, ObjectiveState as GatewayObjectiveState, SessionEvent,
    SessionNodeId, SessionNodeState, SessionTranscriptRole, SessionTreeSnapshot,
''',
    "frontend transcript role import",
)
source = replace_once(
    source,
    '''    BackendError, BackendEvent, DialogId, ExtensionUiRequest, ModelRef, ObjectiveId,
    ObjectiveSource, ObjectiveState, ObjectiveSummary, RunId, RunKind, RunState, RuntimeSnapshot,
    SessionId, ToolCallId, ToolExecutionOutcome, TranscriptBlock, TranscriptRole,
''',
    '''    BackendError, BackendEvent, DialogId, ExtensionUiRequest, ModelRef, NotificationLevel,
    ObjectiveId, ObjectiveSource, ObjectiveState, ObjectiveSummary, RunId, RunKind, RunState,
    RuntimeSnapshot, SessionId, ToolCallId, ToolExecutionOutcome, TranscriptBlock, TranscriptRole,
''',
    "frontend notification import",
)
source = replace_once(
    source,
    '''        match event.event {
            SessionEvent::Text { text } => vec![BackendEvent::TranscriptAppended(
''',
    '''        match event.event {
            SessionEvent::TranscriptAppended {
                id,
                role,
                text,
                complete,
            } => vec![BackendEvent::TranscriptAppended(TranscriptBlock {
                id,
                run_id,
                role: runtime_transcript_role(role),
                text,
                complete,
            })],
            SessionEvent::TranscriptUpdated {
                id,
                role,
                text,
                complete,
            } => vec![BackendEvent::TranscriptUpdated(TranscriptBlock {
                id,
                run_id,
                role: runtime_transcript_role(role),
                text,
                complete,
            })],
            SessionEvent::Text { text } => vec![BackendEvent::TranscriptAppended(
''',
    "frontend transcript reconstruction",
)
source = replace_once(
    source,
    '''            SessionEvent::Completed
            | SessionEvent::Failed { .. }
            | SessionEvent::Cancelled { .. } => backend
                .runs
                .iter()
                .find(|run| run.id == run_id)
                .cloned()
                .map(BackendEvent::RunChanged)
                .into_iter()
                .collect(),
''',
    '''            SessionEvent::Completed => backend
                .runs
                .iter()
                .find(|run| run.id == run_id)
                .cloned()
                .map(BackendEvent::RunChanged)
                .into_iter()
                .collect(),
            SessionEvent::Failed { message } => {
                let mut events = backend
                    .runs
                    .iter()
                    .find(|run| run.id == run_id)
                    .cloned()
                    .map(BackendEvent::RunChanged)
                    .into_iter()
                    .collect::<Vec<_>>();
                events.push(BackendEvent::Notification {
                    level: NotificationLevel::Error,
                    message,
                });
                events
            }
            SessionEvent::Cancelled { reason } => {
                let mut events = backend
                    .runs
                    .iter()
                    .find(|run| run.id == run_id)
                    .cloned()
                    .map(BackendEvent::RunChanged)
                    .into_iter()
                    .collect::<Vec<_>>();
                events.push(BackendEvent::Notification {
                    level: NotificationLevel::Warning,
                    message: reason,
                });
                events
            }
''',
    "async failure projection",
)
source = replace_once(
    source,
    '''fn run_ids_by_node(
''',
    '''fn runtime_transcript_role(role: SessionTranscriptRole) -> TranscriptRole {
    match role {
        SessionTranscriptRole::User => TranscriptRole::User,
        SessionTranscriptRole::Assistant => TranscriptRole::Assistant,
        SessionTranscriptRole::Thinking => TranscriptRole::Thinking,
        SessionTranscriptRole::Tool => TranscriptRole::Tool,
        SessionTranscriptRole::System => TranscriptRole::System,
    }
}

fn run_ids_by_node(
''',
    "runtime transcript role conversion",
)
path.write_text(source)

# Make authentication discoverable at startup and keep backend failures visible.
path = Path("rust/crates/phenix-ui-core/src/reducer.rs")
source = path.read_text()
source = replace_between(
    source,
    "fn reduce_backend_output",
    "fn reduce_backend_reply",
    '''fn reduce_backend_output(state: &mut AppState, output: BackendOutput) -> Vec<AppEffect> {
    match output {
        BackendOutput::Reply { result, .. } => match result {
            Ok(reply) => {
                let mut effects = reduce_backend_reply(state, reply);
                effects.push(AppEffect::Render);
                effects
            }
            Err(error) => {
                state.notifications.push_back(error.to_string());
                if backend_error_damages_connection(&error) {
                    state.connection = RuntimeConnectionState::Degraded(error.to_string());
                }
                vec![AppEffect::Render]
            }
        },
        BackendOutput::Event(BackendEvent::ExternalCommandRequested { flow_id, command }) => vec![
            AppEffect::RunExternal { flow_id, command },
            AppEffect::Render,
        ],
        BackendOutput::Event(event) => {
            reduce_backend_event(state, event);
            vec![AppEffect::Render]
        }
        BackendOutput::Stopped { result } => {
            state.connection = match result {
                Ok(()) => RuntimeConnectionState::Stopped,
                Err(error) => RuntimeConnectionState::Failed(error.to_string()),
            };
            state.should_quit = true;
            vec![AppEffect::Render, AppEffect::Quit]
        }
    }
}

''',
    "backend output reducer",
)
source = replace_between(
    source,
    "fn reduce_backend_reply",
    "fn reduce_backend_event",
    '''fn reduce_backend_reply(state: &mut AppState, reply: BackendReply) -> Vec<AppEffect> {
    match reply {
        BackendReply::Initialized { snapshot, .. } => {
            state.apply_snapshot(snapshot);
            if state.active_session.is_none()
                && state.capabilities.authentication.provider_listing
            {
                state.view.overlay = Some(OverlayState::AuthenticationProviders {
                    query: String::new(),
                    selected: 0,
                });
                state.view.focus = FocusTarget::Overlay;
                state.notifications.push_back(
                    "Authentication is required before an ACP session can be created.".to_owned(),
                );
                vec![AppEffect::Send(BackendCommand::AuthProviders)]
            } else {
                Vec::new()
            }
        }
        BackendReply::Snapshot(snapshot) => {
            state.apply_snapshot(snapshot);
            Vec::new()
        }
        BackendReply::Sessions(sessions) => {
            if let Some(snapshot) = &mut state.snapshot {
                snapshot.sessions = sessions;
            }
            Vec::new()
        }
        BackendReply::Runs(runs) => {
            if let Some(snapshot) = &mut state.snapshot {
                snapshot.runs = runs;
            }
            Vec::new()
        }
        BackendReply::SessionModes(modes) => {
            state.notifications.push_back(
                modes
                    .into_iter()
                    .map(|mode| {
                        format!("{}{}", if mode.selected { "* " } else { "  " }, mode.id)
                    })
                    .collect::<Vec<_>>()
                    .join(" · "),
            );
            Vec::new()
        }
        BackendReply::Models(models) => {
            state.models = models;
            Vec::new()
        }
        BackendReply::ThinkingLevels(levels) => {
            state.thinking_levels = levels;
            Vec::new()
        }
        BackendReply::AuthProviders(providers) => {
            if providers.is_empty() && state.active_session.is_none() {
                state.notifications.push_back(
                    "The ACP agent requires authentication but advertised no supported authentication method."
                        .to_owned(),
                );
            }
            state.auth_providers = providers;
            Vec::new()
        }
        BackendReply::Commands(commands) => {
            state.commands = commands;
            Vec::new()
        }
        BackendReply::Exported { path } => {
            state
                .notifications
                .push_back(format!("Session exported to {path}"));
            Vec::new()
        }
        BackendReply::Accepted | BackendReply::SessionTree(_) | BackendReply::Completed => {
            Vec::new()
        }
    }
}

''',
    "backend reply reducer",
)
source = replace_once(
    source,
    '''            if matches!(
                state.view.overlay,
                Some(OverlayState::AuthenticationPrompt {
                    flow_id: ref active_flow,
                    ..
                }) if active_flow == &flow_id
            ) {
                close_overlay(state);
            }
''',
    '''            let active_prompt_matches = matches!(
                state.view.overlay,
                Some(OverlayState::AuthenticationPrompt {
                    flow_id: ref active_flow,
                    ..
                }) if active_flow == &flow_id
            );
            if active_prompt_matches
                || matches!(
                    state.view.overlay,
                    Some(OverlayState::AuthenticationProviders { .. })
                )
            {
                close_overlay(state);
            }
''',
    "authentication overlay close",
)
source = replace_once(
    source,
    '''    #[test]
    fn authentication_prompt_becomes_a_native_overlay() {
''',
    '''    #[test]
    fn initialization_without_a_session_opens_native_authentication() {
        let mut capabilities = BackendCapabilities::default();
        capabilities.authentication.provider_listing = true;
        let snapshot = RuntimeSnapshot {
            capabilities,
            health: BackendHealth::Ready,
            active_session: None,
            root_run: None,
            selected_run: None,
            sessions: Vec::new(),
            runs: Vec::new(),
            objectives: Vec::new(),
        };
        let mut state = AppState::default();
        let effects = reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Reply {
                request_id: phenix_runtime_api::RequestId::parse("initialize")
                    .expect("request ID"),
                result: Ok(BackendReply::Initialized {
                    capabilities: snapshot.capabilities.clone(),
                    snapshot,
                }),
            })),
        );
        assert!(matches!(
            state.view.overlay,
            Some(OverlayState::AuthenticationProviders { .. })
        ));
        assert!(effects.contains(&AppEffect::Send(BackendCommand::AuthProviders)));
    }

    #[test]
    fn authentication_prompt_becomes_a_native_overlay() {
''',
    "automatic authentication reducer test",
)
path.write_text(source)
