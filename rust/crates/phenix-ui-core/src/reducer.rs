use crate::state::{AppState, DialogState, RuntimeConnectionState};
use crate::view::{FocusTarget, OverlayState};
use phenix_runtime_api::{
    AuthFlowId, AuthMethod, AuthPromptResponse, BackendCommand, BackendEvent, BackendOutput,
    BackendReply, ExtensionUiResponse, ModelRef, RunId, SessionId, StreamingBehavior,
    ThinkingLevel,
};

const MAX_INPUT_HISTORY: usize = 1_000;

#[derive(Debug, Eq, PartialEq)]
pub enum UserIntent {
    InputChanged(String),
    SubmitPrompt,
    SteerPrompt,
    FollowUpPrompt,
    Abort,
    SelectRun(RunId),
    SwitchSession(SessionId),
    CreateSession,
    OpenModelPicker,
    SelectModel(ModelRef),
    OpenAuthentication,
    StartAuthentication {
        provider_id: String,
        method: AuthMethod,
    },
    RespondToAuthentication {
        flow_id: AuthFlowId,
        response: AuthPromptResponse,
    },
    CancelAuthentication(AuthFlowId),
    Logout(String),
    OpenSessionPicker,
    SelectThinking(ThinkingLevel),
    SetFocus(FocusTarget),
    CloseOverlay,
    ToggleDetails,
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
            state.input.replace(text);
            vec![AppEffect::Render]
        }
        UserIntent::SubmitPrompt => submit_input(state, None),
        UserIntent::SteerPrompt => submit_input(state, Some(StreamingBehavior::Steer)),
        UserIntent::FollowUpPrompt => submit_input(state, Some(StreamingBehavior::FollowUp)),
        UserIntent::Abort => vec![AppEffect::Send(BackendCommand::ExecutionAbort {
            run_id: state.input_target().cloned(),
        })],
        UserIntent::SelectRun(run_id) => {
            state.selected_run = Some(run_id.clone());
            state.view.selected_run = Some(run_id);
            vec![AppEffect::Render]
        }
        UserIntent::SwitchSession(session_id) => {
            state.view.overlay = None;
            state.view.focus = FocusTarget::Input;
            vec![AppEffect::Send(BackendCommand::SessionSwitch { session_id })]
        }
        UserIntent::CreateSession => vec![AppEffect::Send(BackendCommand::SessionCreate {
            parent_session: None,
        })],
        UserIntent::OpenModelPicker => open_model_picker(state),
        UserIntent::SelectModel(model) => {
            let Some(run_id) = state.input_target().cloned() else {
                return no_run_notification(state);
            };
            close_overlay(state);
            vec![
                AppEffect::Send(BackendCommand::ModelSelect { run_id, model }),
                AppEffect::Render,
            ]
        }
        UserIntent::OpenAuthentication => open_authentication(state),
        UserIntent::StartAuthentication {
            provider_id,
            method,
        } => vec![AppEffect::Send(BackendCommand::AuthLoginStart {
            provider_id,
            method,
        })],
        UserIntent::RespondToAuthentication { flow_id, response } => {
            close_overlay(state);
            vec![
                AppEffect::Send(BackendCommand::AuthLoginRespond { flow_id, response }),
                AppEffect::Render,
            ]
        }
        UserIntent::CancelAuthentication(flow_id) => {
            close_overlay(state);
            vec![
                AppEffect::Send(BackendCommand::AuthLoginCancel { flow_id }),
                AppEffect::Render,
            ]
        }
        UserIntent::Logout(provider_id) => vec![AppEffect::Send(BackendCommand::AuthLogout {
            provider_id,
        })],
        UserIntent::OpenSessionPicker => open_session_picker(state),
        UserIntent::SelectThinking(level) => {
            let Some(run_id) = state.input_target().cloned() else {
                return no_run_notification(state);
            };
            close_overlay(state);
            vec![
                AppEffect::Send(BackendCommand::ThinkingSelect { run_id, level }),
                AppEffect::Render,
            ]
        }
        UserIntent::SetFocus(focus) => {
            state.view.focus = focus;
            vec![AppEffect::Render]
        }
        UserIntent::CloseOverlay => {
            close_overlay(state);
            vec![AppEffect::Render]
        }
        UserIntent::ToggleDetails => {
            state.view.show_details = !state.view.show_details;
            vec![AppEffect::Render]
        }
        UserIntent::RespondToDialog(response) => {
            let Some(dialog) = state.dialogs.pop_front() else {
                return Vec::new();
            };
            if state.dialogs.is_empty() {
                state.view.focus = FocusTarget::Input;
            }
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

fn submit_input(
    state: &mut AppState,
    streaming_behavior: Option<StreamingBehavior>,
) -> Vec<AppEffect> {
    let text = std::mem::take(&mut state.input.text);
    state.input.cursor_byte = 0;
    state.input.history_cursor = None;
    if text.trim().is_empty() {
        return vec![AppEffect::Render];
    }
    record_history(state, &text);

    if streaming_behavior.is_none() && text.starts_with('/') {
        return submit_command(state, &text);
    }

    let Some(run_id) = state.input_target().cloned() else {
        state.input.replace(text);
        return no_run_notification(state);
    };
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

fn submit_command(state: &mut AppState, text: &str) -> Vec<AppEffect> {
    let body = text.trim_start_matches('/').trim();
    let (name, arguments) = body
        .split_once(char::is_whitespace)
        .map_or((body, ""), |(name, arguments)| (name, arguments.trim()));

    match name {
        "login" => open_authentication(state),
        "logout" => {
            if arguments.is_empty() {
                state.notifications.push_back(
                    "Use /logout <provider>, or open /login to inspect configured providers."
                        .to_owned(),
                );
                vec![AppEffect::Render]
            } else {
                vec![AppEffect::Send(BackendCommand::AuthLogout {
                    provider_id: arguments.to_owned(),
                })]
            }
        }
        "model" => open_model_picker(state),
        "resume" | "sessions" => open_session_picker(state),
        "new" => vec![AppEffect::Send(BackendCommand::SessionCreate {
            parent_session: None,
        })],
        "compact" => {
            let Some(run_id) = state.input_target().cloned() else {
                return no_run_notification(state);
            };
            vec![AppEffect::Send(BackendCommand::CompactionStart {
                run_id,
                instructions: (!arguments.is_empty()).then(|| arguments.to_owned()),
            })]
        }
        "reload" => vec![AppEffect::Send(BackendCommand::ResourceReload)],
        "abort" => vec![AppEffect::Send(BackendCommand::ExecutionAbort {
            run_id: state.input_target().cloned(),
        })],
        "quit" | "exit" => reduce_user_intent(state, UserIntent::Quit),
        "thinking" => {
            let Some(run_id) = state.input_target().cloned() else {
                return no_run_notification(state);
            };
            vec![AppEffect::Send(BackendCommand::ThinkingLevels { run_id })]
        }
        "" => vec![AppEffect::Render],
        _ => {
            let Some(run_id) = state.input_target().cloned() else {
                return no_run_notification(state);
            };
            vec![AppEffect::Send(BackendCommand::CommandInvoke {
                run_id,
                name: name.to_owned(),
                arguments: arguments.to_owned(),
            })]
        }
    }
}

fn record_history(state: &mut AppState, text: &str) {
    if state.input.history.back().is_some_and(|last| last == text) {
        return;
    }
    state.input.history.push_back(text.to_owned());
    while state.input.history.len() > MAX_INPUT_HISTORY {
        state.input.history.pop_front();
    }
}

fn open_model_picker(state: &mut AppState) -> Vec<AppEffect> {
    state.view.overlay = Some(OverlayState::ModelPicker {
        query: String::new(),
        selected: 0,
    });
    state.view.focus = FocusTarget::Overlay;
    vec![
        AppEffect::Send(BackendCommand::ModelList),
        AppEffect::Render,
    ]
}

fn open_authentication(state: &mut AppState) -> Vec<AppEffect> {
    state.view.overlay = Some(OverlayState::AuthenticationProviders {
        query: String::new(),
        selected: 0,
    });
    state.view.focus = FocusTarget::Overlay;
    vec![
        AppEffect::Send(BackendCommand::AuthProviders),
        AppEffect::Render,
    ]
}

fn open_session_picker(state: &mut AppState) -> Vec<AppEffect> {
    state.view.overlay = Some(OverlayState::SessionPicker {
        query: String::new(),
        selected: 0,
    });
    state.view.focus = FocusTarget::Overlay;
    vec![
        AppEffect::Send(BackendCommand::SessionList),
        AppEffect::Render,
    ]
}

fn close_overlay(state: &mut AppState) {
    state.view.overlay = None;
    state.view.focus = FocusTarget::Input;
}

fn no_run_notification(state: &mut AppState) -> Vec<AppEffect> {
    state
        .notifications
        .push_back("No run is available for this operation.".to_owned());
    vec![AppEffect::Render]
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
        BackendReply::Models(models) => state.models = models,
        BackendReply::ThinkingLevels(levels) => state.thinking_levels = levels,
        BackendReply::AuthProviders(providers) => state.auth_providers = providers,
        BackendReply::Commands(commands) => state.commands = commands,
        BackendReply::Exported { path } => state
            .notifications
            .push_back(format!("Session exported to {path}")),
        BackendReply::Accepted
        | BackendReply::SessionTree(_)
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
        BackendEvent::AuthPromptRequested { flow_id, prompt } => {
            state.auth_flow_mut(flow_id.clone()).prompt = Some(prompt.clone());
            state.view.overlay = Some(OverlayState::AuthenticationPrompt {
                flow_id,
                prompt,
                input: String::new(),
                selected: 0,
            });
            state.view.focus = FocusTarget::Overlay;
        }
        BackendEvent::AuthNotice { flow_id, notice } => {
            state.auth_flow_mut(flow_id).notices.push_back(notice);
        }
        BackendEvent::AuthFinished {
            flow_id,
            provider_id,
            result,
        } => {
            state.auth_flows.remove(&flow_id);
            match result {
                Ok(()) => state
                    .notifications
                    .push_back(format!("Authenticated with {provider_id}.")),
                Err(message) => state.notifications.push_back(format!(
                    "Authentication for {provider_id} failed: {message}"
                )),
            }
            if matches!(
                state.view.overlay,
                Some(OverlayState::AuthenticationPrompt {
                    ref flow_id: active_flow,
                    ..
                }) if active_flow == &flow_id
            ) {
                close_overlay(state);
            }
        }
        BackendEvent::ExtensionUiRequested { dialog_id, request } => {
            state.dialogs.push_back(DialogState {
                id: dialog_id,
                request,
            });
            state.view.focus = FocusTarget::Overlay;
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
        | BackendEvent::QueueChanged { .. } => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{
        AuthFlowId, AuthPrompt, BackendEvent, BackendOutput, DialogId, ExtensionUiRequest, RunId,
        TranscriptBlock, TranscriptRole,
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
    fn login_command_opens_native_provider_picker_and_requests_data() {
        let mut state = AppState::default();
        state.input.replace("/login".to_owned());
        let effects = reduce(&mut state, AppEvent::User(UserIntent::SubmitPrompt));
        assert!(matches!(
            state.view.overlay,
            Some(OverlayState::AuthenticationProviders { .. })
        ));
        assert!(effects.contains(&AppEffect::Send(BackendCommand::AuthProviders)));
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
        assert_eq!(state.selected_run, Some(child.clone()));
        assert_eq!(state.view.selected_run, Some(child));
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
    fn authentication_prompt_becomes_a_native_overlay() {
        let flow_id = AuthFlowId::parse("auth-1").expect("flow ID");
        let mut state = AppState::default();
        reduce(
            &mut state,
            AppEvent::Backend(BackendOutput::Event(BackendEvent::AuthPromptRequested {
                flow_id: flow_id.clone(),
                prompt: AuthPrompt::Secret {
                    message: "API key".to_owned(),
                    placeholder: None,
                },
            })),
        );
        assert!(state.auth_flows.contains_key(&flow_id));
        assert!(matches!(
            state.view.overlay,
            Some(OverlayState::AuthenticationPrompt { .. })
        ));
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
        assert_eq!(state.view.focus, FocusTarget::Overlay);
    }
}
