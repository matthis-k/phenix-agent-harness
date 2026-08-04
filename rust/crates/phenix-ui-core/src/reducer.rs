use crate::state::{AppState, DialogState, RuntimeConnectionState};
use phenix_runtime_api::{
    BackendCommand, BackendEvent, BackendOutput, BackendReply, ExtensionUiResponse, RunId, SessionId,
    StreamingBehavior,
};

#[derive(Debug, Eq, PartialEq)]
pub enum UserIntent {
    InputChanged(String),
    SubmitPrompt,
    SteerPrompt,
    FollowUpPrompt,
    Abort,
    SelectRun(RunId),
    SwitchSession(SessionId),
    RespondToDialog(ExtensionUiResponse),
    Quit,
}

#[derive(Debug, Eq, PartialEq)]
pub enum AppEvent {
    User(UserIntent),
    Backend(BackendOutput),
    BackendSubmitFailed(String),
}

#[derive(Debug, Eq, PartialEq)]
pub enum AppEffect {
    Send(BackendCommand),
    Render,
    Quit,
}

pub fn reduce(state: &mut AppState, event: AppEvent) -> Vec<AppEffect> {
    match event {
        AppEvent::User(intent) => reduce_user_intent(state, intent),
        AppEvent::Backend(output) => reduce_backend_output(state, output),
        AppEvent::BackendSubmitFailed(message) => {
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
            run_id: state.input_target().cloned(),
        })],
        UserIntent::SelectRun(run_id) => {
            state.selected_run = Some(run_id);
            vec![AppEffect::Render]
        }
        UserIntent::SwitchSession(session_id) => vec![AppEffect::Send(
            BackendCommand::SessionSwitch { session_id },
        )],
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
    let Some(run_id) = state.input_target().cloned() else {
        state
            .notifications
            .push_back("No run is available for input.".to_owned());
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
            run_id,
            text,
            images: Vec::new(),
            streaming_behavior,
        }),
        AppEffect::Render,
    ]
}

fn reduce_backend_output(state: &mut AppState, output: BackendOutput) -> Vec<AppEffect> {
    match output {
        BackendOutput::Reply { result, .. } => match result {
            Ok(reply) => reduce_backend_reply(state, reply),
            Err(error) => {
                state.notifications.push_back(error.to_string());
                state.connection = RuntimeConnectionState::Degraded(error.to_string());
            }
        },
        BackendOutput::Event(event) => reduce_backend_event(state, event),
        BackendOutput::Stopped { result } => {
            state.connection = match result {
                Ok(()) => RuntimeConnectionState::Stopped,
                Err(error) => RuntimeConnectionState::Failed(error.to_string()),
            };
        }
    }
    vec![AppEffect::Render]
}

fn reduce_backend_reply(state: &mut AppState, reply: BackendReply) {
    match reply {
        BackendReply::Initialized { snapshot, .. } | BackendReply::Snapshot(snapshot) => {
            state.apply_snapshot(snapshot);
        }
        BackendReply::Sessions(sessions) => {
            if let Some(snapshot) = &mut state.snapshot {
                snapshot.sessions = sessions;
            }
        }
        BackendReply::Runs(runs) => {
            if let Some(snapshot) = &mut state.snapshot {
                snapshot.runs = runs;
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

fn reduce_backend_event(state: &mut AppState, event: BackendEvent) {
    match event {
        BackendEvent::SnapshotChanged(snapshot) => state.apply_snapshot(snapshot),
        BackendEvent::PersistedSessionChanged(session) => {
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
        BackendEvent::RunChanged(run) => {
            if let Some(snapshot) = &mut state.snapshot {
                if let Some(existing) = snapshot
                    .runs
                    .iter_mut()
                    .find(|candidate| candidate.id == run.id)
                {
                    *existing = run;
                } else {
                    snapshot.runs.push(run);
                }
            }
        }
        BackendEvent::ObjectiveChanged(objective) => {
            if let Some(snapshot) = &mut state.snapshot {
                if let Some(existing) = snapshot
                    .objectives
                    .iter_mut()
                    .find(|candidate| candidate.id == objective.id)
                {
                    *existing = objective;
                } else {
                    snapshot.objectives.push(objective);
                }
            }
        }
        BackendEvent::TranscriptAppended(block) => {
            state.transcript_mut(block.run_id.clone()).append(block);
        }
        BackendEvent::TranscriptUpdated(block) => {
            state.transcript_mut(block.run_id.clone()).update(block);
        }
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
        BackendEvent::ToolStarted { .. }
        | BackendEvent::ToolUpdated { .. }
        | BackendEvent::ToolFinished { .. }
        | BackendEvent::QueueChanged { .. }
        | BackendEvent::AuthPromptRequested { .. }
        | BackendEvent::AuthNotice { .. }
        | BackendEvent::AuthFinished { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{
        BackendEvent, BackendOutput, DialogId, ExtensionUiRequest, RunId, TranscriptBlock,
        TranscriptRole,
    };

    #[test]
    fn prompt_submission_moves_owned_text_into_a_run_targeted_backend_effect() {
        let run = RunId::parse("root-run").expect("valid run");
        let mut state = AppState {
            root_run: Some(run.clone()),
            selected_run: Some(run.clone()),
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
                run_id,
                text,
                ..
            })) if run_id == &run && text == "inspect repository"
        ));
    }

    #[test]
    fn selecting_a_child_run_changes_input_target_without_switching_persistence() {
        let root = RunId::parse("root-run").expect("valid root");
        let child = RunId::parse("child-run").expect("valid child");
        let mut state = AppState {
            root_run: Some(root),
            ..AppState::default()
        };
        let effects = reduce(
            &mut state,
            AppEvent::User(UserIntent::SelectRun(child.clone())),
        );
        assert_eq!(state.selected_run, Some(child));
        assert_eq!(effects, vec![AppEffect::Render]);
    }

    #[test]
    fn transcript_updates_replace_by_stable_identity_within_each_run() {
        let run = RunId::parse("root-run").expect("valid run");
        let mut state = AppState::default();
        let block = TranscriptBlock {
            id: "assistant-1".to_owned(),
            run_id: run.clone(),
            role: TranscriptRole::Assistant,
            text: "partial".to_owned(),
            complete: false,
        };
        reduce(
            &mut state,
            AppEvent::Backend(BackendOutput::Event(BackendEvent::TranscriptAppended(
                block.clone(),
            ))),
        );
        reduce(
            &mut state,
            AppEvent::Backend(BackendOutput::Event(BackendEvent::TranscriptUpdated(
                TranscriptBlock {
                    text: "complete".to_owned(),
                    complete: true,
                    ..block
                },
            ))),
        );
        let transcript = state.transcript(&run).expect("run transcript");
        assert_eq!(transcript.blocks.len(), 1);
        assert_eq!(transcript.blocks[0].text, "complete");
        assert!(transcript.blocks[0].complete);
    }

    #[test]
    fn dialogs_queue_semantically_without_importing_backend_widgets() {
        let mut state = AppState::default();
        reduce(
            &mut state,
            AppEvent::Backend(BackendOutput::Event(BackendEvent::ExtensionUiRequested {
                dialog_id: DialogId::parse("dialog-1").expect("valid dialog"),
                request: ExtensionUiRequest::Confirm {
                    title: "Apply change?".to_owned(),
                    message: "This mutates the repository.".to_owned(),
                },
            })),
        );
        assert_eq!(state.dialogs.len(), 1);
    }
}
