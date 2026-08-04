use crate::state::{AppState, DialogState, RuntimeConnectionState};
use phenix_runtime_api::{
    BackendCommand, BackendEvent, BackendReply, ExtensionUiResponse, SessionId, StreamingBehavior,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UserIntent {
    InputChanged(String),
    SubmitPrompt,
    SteerPrompt,
    FollowUpPrompt,
    Abort,
    SelectSession(SessionId),
    RespondToDialog(ExtensionUiResponse),
    Quit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppEvent {
    User(UserIntent),
    Backend(BackendEvent),
    BackendReply(BackendReply),
    BackendRequestFailed(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppEffect {
    Send(BackendCommand),
    Render,
    Quit,
}

pub fn reduce(state: &mut AppState, event: AppEvent) -> Vec<AppEffect> {
    match event {
        AppEvent::User(intent) => reduce_user_intent(state, intent),
        AppEvent::Backend(event) => reduce_backend_event(state, event),
        AppEvent::BackendReply(reply) => {
            reduce_backend_reply(state, reply);
            vec![AppEffect::Render]
        }
        AppEvent::BackendRequestFailed(message) => {
            state.connection = RuntimeConnectionState::Degraded(message.clone());
            state.notifications.push_back(message);
            vec![AppEffect::Render]
        }
    }
}

fn reduce_user_intent(state: &mut AppState, intent: UserIntent) -> Vec<AppEffect> {
    match intent {
        UserIntent::InputChanged(text) => {
            state.input.cursor_byte = text.len();
            state.input.text = text;
            vec![AppEffect::Render]
        }
        UserIntent::SubmitPrompt => submit_prompt(state, None),
        UserIntent::SteerPrompt => submit_prompt(state, Some(StreamingBehavior::Steer)),
        UserIntent::FollowUpPrompt => submit_prompt(state, Some(StreamingBehavior::FollowUp)),
        UserIntent::Abort => vec![AppEffect::Send(BackendCommand::ExecutionAbort {
            run_id: None,
        })],
        UserIntent::SelectSession(session_id) => {
            state.active_session = Some(session_id.clone());
            vec![
                AppEffect::Send(BackendCommand::SessionSwitch { session_id }),
                AppEffect::Render,
            ]
        }
        UserIntent::RespondToDialog(response) => {
            let Some(dialog) = state.dialogs.pop_front() else {
                return Vec::new();
            };
            vec![
                AppEffect::Send(BackendCommand::ExtensionUiRespond {
                    dialog_id: dialog.id,
                    response,
                }),
                AppEffect::Render,
            ]
        }
        UserIntent::Quit => {
            state.should_quit = true;
            vec![AppEffect::Send(BackendCommand::Shutdown), AppEffect::Quit]
        }
    }
}

fn submit_prompt(
    state: &mut AppState,
    streaming_behavior: Option<StreamingBehavior>,
) -> Vec<AppEffect> {
    let Some(session_id) = state.active_session.clone() else {
        state
            .notifications
            .push_back("No active session is available.".to_owned());
        return vec![AppEffect::Render];
    };
    let text = std::mem::take(&mut state.input.text);
    state.input.cursor_byte = 0;
    if text.trim().is_empty() {
        return vec![AppEffect::Render];
    }
    state.input.history.push_back(text.clone());
    vec![
        AppEffect::Send(BackendCommand::PromptSubmit {
            session_id,
            text,
            images: Vec::new(),
            streaming_behavior,
        }),
        AppEffect::Render,
    ]
}

fn reduce_backend_reply(state: &mut AppState, reply: BackendReply) {
    match reply {
        BackendReply::Initialized {
            capabilities,
            snapshot,
        } => {
            state.connection = RuntimeConnectionState::from(&snapshot.health);
            state.active_session = snapshot.active_session.clone();
            state.capabilities = capabilities;
            state.snapshot = Some(snapshot);
        }
        BackendReply::Snapshot(snapshot) => {
            state.connection = RuntimeConnectionState::from(&snapshot.health);
            state.active_session = snapshot.active_session.clone();
            state.capabilities = snapshot.capabilities.clone();
            state.snapshot = Some(snapshot);
        }
        BackendReply::Sessions(sessions) => {
            if let Some(snapshot) = &mut state.snapshot {
                snapshot.sessions = sessions;
            }
        }
        BackendReply::Accepted
        | BackendReply::SessionTree(_)
        | BackendReply::Models(_)
        | BackendReply::ThinkingLevels(_)
        | BackendReply::AuthProviders(_)
        | BackendReply::Commands(_)
        | BackendReply::Exported { .. }
        | BackendReply::Completed => {}
    }
}

fn reduce_backend_event(state: &mut AppState, event: BackendEvent) -> Vec<AppEffect> {
    match event {
        BackendEvent::SnapshotChanged(snapshot) => {
            state.connection = RuntimeConnectionState::from(&snapshot.health);
            state.active_session = snapshot.active_session.clone();
            state.capabilities = snapshot.capabilities.clone();
            state.snapshot = Some(snapshot);
        }
        BackendEvent::SessionChanged(session) => {
            if state.active_session.as_ref() == Some(&session.id) {
                state.active_session = Some(session.id.clone());
            }
            if let Some(snapshot) = &mut state.snapshot {
                if let Some(existing) = snapshot
                    .sessions
                    .iter_mut()
                    .find(|candidate| candidate.id == session.id)
                {
                    *existing = session;
                } else {
                    snapshot.sessions.push(session);
                }
            }
        }
        BackendEvent::TranscriptAppended(block) => state.transcript.append(block),
        BackendEvent::TranscriptUpdated(block) => state.transcript.update(block),
        BackendEvent::ExtensionUiRequested { dialog_id, request } => {
            state.dialogs.push_back(DialogState {
                id: dialog_id,
                request,
            });
        }
        BackendEvent::Notification { message, .. } => {
            state.notifications.push_back(message);
        }
        BackendEvent::StatusChanged { key, text } => {
            if let Some(text) = text {
                state.statuses.insert(key, text);
            } else {
                state.statuses.remove(&key);
            }
        }
        BackendEvent::HealthChanged(health) => {
            state.connection = RuntimeConnectionState::from(&health);
        }
        BackendEvent::Stopped { result } => {
            state.connection = match result {
                Ok(()) => RuntimeConnectionState::Stopped,
                Err(message) => RuntimeConnectionState::Failed(message),
            };
        }
        BackendEvent::ToolStarted { .. }
        | BackendEvent::ToolUpdated { .. }
        | BackendEvent::ToolFinished { .. }
        | BackendEvent::QueueChanged { .. }
        | BackendEvent::AuthPromptRequested { .. }
        | BackendEvent::AuthNotice { .. }
        | BackendEvent::AuthFinished { .. } => {}
    }
    vec![AppEffect::Render]
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{
        BackendEvent, DialogId, ExtensionUiRequest, SessionId, TranscriptBlock, TranscriptRole,
    };

    #[test]
    fn prompt_submission_moves_owned_text_into_a_backend_effect() {
        let session = SessionId::parse("root").expect("valid session");
        let mut state = AppState {
            active_session: Some(session.clone()),
            ..AppState::default()
        };
        reduce(
            &mut state,
            AppEvent::User(UserIntent::InputChanged("inspect repository".to_owned())),
        );
        let effects = reduce(&mut state, AppEvent::User(UserIntent::SubmitPrompt));
        assert_eq!(state.input.text, "");
        assert!(matches!(
            effects.first(),
            Some(AppEffect::Send(BackendCommand::PromptSubmit {
                session_id,
                text,
                ..
            })) if session_id == &session && text == "inspect repository"
        ));
    }

    #[test]
    fn transcript_updates_replace_by_stable_block_identity() {
        let session = SessionId::parse("root").expect("valid session");
        let mut state = AppState::default();
        let block = TranscriptBlock {
            id: "assistant-1".to_owned(),
            session_id: session,
            role: TranscriptRole::Assistant,
            text: "partial".to_owned(),
            complete: false,
        };
        reduce(
            &mut state,
            AppEvent::Backend(BackendEvent::TranscriptAppended(block.clone())),
        );
        reduce(
            &mut state,
            AppEvent::Backend(BackendEvent::TranscriptUpdated(TranscriptBlock {
                text: "complete".to_owned(),
                complete: true,
                ..block
            })),
        );
        assert_eq!(state.transcript.blocks.len(), 1);
        assert_eq!(state.transcript.blocks[0].text, "complete");
        assert!(state.transcript.blocks[0].complete);
    }

    #[test]
    fn dialogs_queue_semantically_without_importing_backend_widgets() {
        let mut state = AppState::default();
        reduce(
            &mut state,
            AppEvent::Backend(BackendEvent::ExtensionUiRequested {
                dialog_id: DialogId::parse("dialog-1").expect("valid dialog"),
                request: ExtensionUiRequest::Confirm {
                    title: "Apply change?".to_owned(),
                    message: "This mutates the repository.".to_owned(),
                },
            }),
        );
        assert_eq!(state.dialogs.len(), 1);
    }
}
