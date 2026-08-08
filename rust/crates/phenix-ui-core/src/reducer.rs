use crate::state::{AppState, DialogState, RuntimeConnectionState};
use crate::view::{FocusTarget, OverlayState};
use phenix_runtime_api::{
    AuthFlowId, AuthMethod, AuthPromptResponse, BackendCommand, BackendError, BackendEvent,
    BackendOutput, BackendReply, CommandSource, CommandSummary, ExtensionUiResponse, ModelRef,
    RunId, SessionId, StreamingBehavior, ThinkingLevel, ToolExecutionOutcome, TranscriptBlock,
    TranscriptRole,
};

const MAX_INPUT_HISTORY: usize = 1_000;
const ROUTING_PROFILES: &[&str] = &["free", "opencode-go", "chatgpt-plus", "mixed"];

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
    Backend(Box<BackendOutput>),
    BackendSubmitFailed(String),
}

#[derive(Debug, Eq, PartialEq)]
pub enum AppEffect {
    Send(BackendCommand),
    RunExternal {
        flow_id: AuthFlowId,
        command: phenix_runtime_api::ExternalCommand,
    },
    Render,
    Quit,
}

pub fn reduce(state: &mut AppState, event: AppEvent) -> Vec<AppEffect> {
    match event {
        AppEvent::User(intent) => reduce_user_intent(state, intent),
        AppEvent::Backend(output) => reduce_backend_output(state, *output),
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
            close_overlay(state);
            vec![
                AppEffect::Send(BackendCommand::SessionSwitch { session_id }),
                AppEffect::Render,
            ]
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
        UserIntent::Logout(provider_id) => {
            vec![AppEffect::Send(BackendCommand::AuthLogout { provider_id })]
        }
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
        UserIntent::RespondToDialog(response) => respond_to_dialog(state, response),
        UserIntent::Quit => {
            if state.exit_requested {
                return Vec::new();
            }
            state.exit_requested = true;
            state
                .notifications
                .push_back("Stopping the runtime…".to_owned());
            vec![AppEffect::Send(BackendCommand::Shutdown), AppEffect::Render]
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
        "logout" if arguments.is_empty() => {
            state.notifications.push_back(
                "Use /logout <provider>, or /login to inspect configured providers.".to_owned(),
            );
            vec![AppEffect::Render]
        }
        "logout" => vec![AppEffect::Send(BackendCommand::AuthLogout {
            provider_id: arguments.to_owned(),
        })],
        "model" => open_model_picker(state),
        "routing" if arguments.is_empty() => open_model_picker(state),
        "routing" => select_routing_profile(state, arguments),
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
        "mode" => {
            let Some(run_id) = state.input_target().cloned() else {
                return no_run_notification(state);
            };
            if arguments.is_empty() {
                vec![AppEffect::Send(BackendCommand::SessionModes { run_id })]
            } else {
                vec![AppEffect::Send(BackendCommand::SessionModeSelect {
                    run_id,
                    mode_id: arguments.to_owned(),
                })]
            }
        }
        "thinking" => {
            let Some(run_id) = state.input_target().cloned() else {
                return no_run_notification(state);
            };
            vec![AppEffect::Send(BackendCommand::ThinkingLevels { run_id })]
        }
        "" => vec![AppEffect::Render],
        _ => forward_acp_command(state, text, name, arguments),
    }
}

fn forward_acp_command(
    state: &mut AppState,
    text: &str,
    name: &str,
    arguments: &str,
) -> Vec<AppEffect> {
    let Some(run_id) = state.input_target().cloned() else {
        return no_run_notification(state);
    };
    let command = if acp_command_is_advertised(state, name) {
        BackendCommand::CommandInvoke {
            run_id,
            name: name.to_owned(),
            arguments: arguments.to_owned(),
        }
    } else {
        BackendCommand::PromptSubmit {
            run_id,
            text: text.to_owned(),
            images: Vec::new(),
            streaming_behavior: None,
        }
    };
    vec![AppEffect::Send(command), AppEffect::Render]
}

fn select_routing_profile(state: &mut AppState, profile: &str) -> Vec<AppEffect> {
    if !ROUTING_PROFILES.contains(&profile) {
        state.notifications.push_back(format!(
            "Unknown routing profile `{profile}`. Available profiles: {}.",
            ROUTING_PROFILES.join(", ")
        ));
        return vec![AppEffect::Render];
    }
    let Some(run_id) = state.input_target().cloned() else {
        return no_run_notification(state);
    };
    vec![
        AppEffect::Send(BackendCommand::ModelSelect {
            run_id,
            model: ModelRef {
                provider: "phenix".to_owned(),
                model: profile.to_owned(),
            },
        }),
        AppEffect::Render,
    ]
}

fn acp_command_is_advertised(state: &AppState, name: &str) -> bool {
    state.commands.iter().any(|command| command.name == name)
}

fn respond_to_dialog(state: &mut AppState, response: ExtensionUiResponse) -> Vec<AppEffect> {
    let Some(dialog) = state.dialogs.pop_front() else {
        return Vec::new();
    };
    if let Some(next) = state.dialogs.front() {
        state.view.overlay = Some(OverlayState::ExtensionDialog {
            dialog_id: next.id.clone(),
            request: next.request.clone(),
            input: String::new(),
            selected: 0,
        });
    } else {
        close_overlay(state);
    }
    vec![
        AppEffect::Send(BackendCommand::ExtensionUiRespond {
            dialog_id: dialog.id,
            response,
        }),
        AppEffect::Render,
    ]
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
            Ok(reply) => {
                let initialized = matches!(&reply, BackendReply::Initialized { .. });
                reduce_backend_reply(state, reply);
                if initialized {
                    return vec![
                        AppEffect::Send(BackendCommand::CommandList),
                        AppEffect::Render,
                    ];
                }
            }
            Err(error) => {
                state.notifications.push_back(error.to_string());
                if backend_error_damages_connection(&error) {
                    state.connection = RuntimeConnectionState::Degraded(error.to_string());
                }
            }
        },
        BackendOutput::Event(BackendEvent::ExternalCommandRequested { flow_id, command }) => {
            return vec![
                AppEffect::RunExternal { flow_id, command },
                AppEffect::Render,
            ];
        }
        BackendOutput::Event(event) => reduce_backend_event(state, event),
        BackendOutput::Stopped { result } => {
            state.connection = match result {
                Ok(()) => RuntimeConnectionState::Stopped,
                Err(error) => RuntimeConnectionState::Failed(error.to_string()),
            };
            state.should_quit = true;
            return vec![AppEffect::Render, AppEffect::Quit];
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
        BackendReply::SessionModes(modes) => state.notifications.push_back(
            modes
                .into_iter()
                .map(|mode| format!("{}{}", if mode.selected { "* " } else { "  " }, mode.id))
                .collect::<Vec<_>>()
                .join(" · "),
        ),
        BackendReply::Models(models) => state.models = models,
        BackendReply::ThinkingLevels(levels) => state.thinking_levels = levels,
        BackendReply::AuthProviders(providers) => state.auth_providers = providers,
        BackendReply::Commands(mut commands) => {
            if !commands.iter().any(|command| command.name == "routing") {
                commands.push(CommandSummary {
                    name: "routing".to_owned(),
                    description: Some(
                        "Select a Phenix routing profile: free, opencode-go, chatgpt-plus, or mixed"
                            .to_owned(),
                    ),
                    source: CommandSource::BuiltIn,
                });
            }
            state.commands = commands;
        }
        BackendReply::Exported { path } => state
            .notifications
            .push_back(format!("Session exported to {path}")),
        BackendReply::Accepted | BackendReply::SessionTree(_) | BackendReply::Completed => {}
    }
}

fn reduce_backend_event(state: &mut AppState, event: BackendEvent) {
    match event {
        BackendEvent::SnapshotChanged(snapshot) => state.apply_snapshot(snapshot),
        BackendEvent::PersistedSessionChanged(session) => {
            if let Some(snapshot) = &mut state.snapshot {
                upsert_by(&mut snapshot.sessions, session, |item| item.id.clone());
            }
        }
        BackendEvent::RunChanged(run) => {
            if let Some(snapshot) = &mut state.snapshot {
                upsert_by(&mut snapshot.runs, run, |item| item.id.clone());
            }
        }
        BackendEvent::ObjectiveChanged(objective) => {
            if let Some(snapshot) = &mut state.snapshot {
                upsert_by(&mut snapshot.objectives, objective, |item| item.id.clone());
            }
        }
        BackendEvent::TranscriptAppended(block) => {
            state.transcript_mut(block.run_id.clone()).append(block);
        }
        BackendEvent::TranscriptUpdated(block) => {
            state.transcript_mut(block.run_id.clone()).update(block);
        }
        BackendEvent::ExternalCommandRequested { .. } => {
            unreachable!("handled before reducer projection")
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
                    flow_id: ref active_flow,
                    ..
                }) if active_flow == &flow_id
            ) {
                close_overlay(state);
            }
        }
        BackendEvent::ExtensionUiRequested { dialog_id, request } => {
            let dialog = DialogState {
                id: dialog_id.clone(),
                request: request.clone(),
            };
            state.dialogs.push_back(dialog);
            if state.dialogs.len() == 1 {
                state.view.overlay = Some(OverlayState::ExtensionDialog {
                    dialog_id,
                    request,
                    input: String::new(),
                    selected: 0,
                });
                state.view.focus = FocusTarget::Overlay;
            }
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
        BackendEvent::ToolStarted {
            run_id,
            tool_call_id,
            tool_name,
            input_summary,
            ..
        } => state
            .transcript_mut(run_id.clone())
            .append(TranscriptBlock {
                id: tool_block_id(&tool_call_id),
                run_id,
                role: TranscriptRole::Tool,
                text: format!("{tool_name}\n{input_summary}"),
                complete: false,
            }),
        BackendEvent::ToolUpdated {
            run_id,
            tool_call_id,
            output,
        } => state
            .transcript_mut(run_id.clone())
            .update(TranscriptBlock {
                id: tool_block_id(&tool_call_id),
                run_id,
                role: TranscriptRole::Tool,
                text: output,
                complete: false,
            }),
        BackendEvent::ToolFinished {
            run_id,
            tool_call_id,
            outcome,
            output_summary,
        } => state
            .transcript_mut(run_id.clone())
            .update(TranscriptBlock {
                id: tool_block_id(&tool_call_id),
                run_id,
                role: TranscriptRole::Tool,
                text: format!("{}\n{output_summary}", tool_outcome_label(&outcome)),
                complete: true,
            }),
        BackendEvent::QueueChanged {
            run_id,
            steering,
            follow_ups,
        } => {
            let key = format!("queue.{run_id}");
            let pending = steering.len() + follow_ups.len();
            if pending == 0 {
                state.statuses.remove(&key);
            } else {
                state.statuses.insert(key, format!("{pending} queued"));
            }
        }
    }
}

fn backend_error_damages_connection(error: &BackendError) -> bool {
    matches!(
        error,
        BackendError::Start(_)
            | BackendError::Transport(_)
            | BackendError::Disconnected
            | BackendError::Panicked
    )
}

fn tool_block_id(tool_call_id: &phenix_runtime_api::ToolCallId) -> String {
    format!("tool-{tool_call_id}")
}

fn tool_outcome_label(outcome: &ToolExecutionOutcome) -> &'static str {
    match outcome {
        ToolExecutionOutcome::Succeeded => "completed",
        ToolExecutionOutcome::Failed => "failed",
        ToolExecutionOutcome::Aborted => "aborted",
    }
}

fn upsert_by<T, K: PartialEq>(items: &mut Vec<T>, item: T, key: impl Fn(&T) -> K) {
    let item_key = key(&item);
    if let Some(existing) = items
        .iter_mut()
        .find(|candidate| key(candidate) == item_key)
    {
        *existing = item;
    } else {
        items.push(item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{
        AuthPrompt, BackendHealth, DialogId, ExtensionUiRequest, RunKind, RunState, RunSummary,
        RuntimeSnapshot, TranscriptBlock, TranscriptRole,
    };

    #[test]
    fn prompt_submission_moves_owned_text_into_a_run_targeted_backend_effect() {
        let run = RunId::parse("root-run").expect("valid run");
        let mut state = state_with_run(run.clone());
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
    fn login_command_opens_native_provider_picker() {
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
    fn routing_command_selects_a_typed_virtual_model() {
        let run = RunId::parse("root-run").expect("valid run");
        let mut state = state_with_run(run.clone());
        state.input.replace("/routing mixed".to_owned());
        let effects = reduce(&mut state, AppEvent::User(UserIntent::SubmitPrompt));
        assert!(
            effects.contains(&AppEffect::Send(BackendCommand::ModelSelect {
                run_id: run,
                model: ModelRef {
                    provider: "phenix".to_owned(),
                    model: "mixed".to_owned(),
                },
            }))
        );
    }

    #[test]
    fn advertised_acp_command_uses_the_typed_command_operation() {
        let run = RunId::parse("root-run").expect("valid run");
        let mut state = state_with_run(run.clone());
        state.commands.push(CommandSummary {
            name: "review".to_owned(),
            description: None,
            source: CommandSource::Extension,
        });
        state.input.replace("/review src".to_owned());
        let effects = reduce(&mut state, AppEvent::User(UserIntent::SubmitPrompt));
        assert!(
            effects.contains(&AppEffect::Send(BackendCommand::CommandInvoke {
                run_id: run,
                name: "review".to_owned(),
                arguments: "src".to_owned(),
            }))
        );
    }

    #[test]
    fn unadvertised_command_is_forwarded_unchanged_to_acp() {
        let run = RunId::parse("root-run").expect("valid run");
        let mut state = state_with_run(run.clone());
        state.input.replace("/phenix status".to_owned());
        let effects = reduce(&mut state, AppEvent::User(UserIntent::SubmitPrompt));
        assert!(
            effects.contains(&AppEffect::Send(BackendCommand::PromptSubmit {
                run_id: run,
                text: "/phenix status".to_owned(),
                images: Vec::new(),
                streaming_behavior: None,
            }))
        );
    }

    #[test]
    fn backend_commands_include_the_frontend_routing_command() {
        let mut state = AppState::default();
        reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Reply {
                request_id: phenix_runtime_api::RequestId::parse("commands").expect("request ID"),
                result: Ok(BackendReply::Commands(Vec::new())),
            })),
        );
        assert!(state
            .commands
            .iter()
            .any(|command| command.name == "routing"));
    }

    #[test]
    fn authentication_prompt_becomes_a_native_overlay() {
        let flow_id = AuthFlowId::parse("auth-1").expect("flow ID");
        let mut state = AppState::default();
        reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Event(
                BackendEvent::AuthPromptRequested {
                    flow_id: flow_id.clone(),
                    prompt: AuthPrompt::Secret {
                        message: "API key".to_owned(),
                        placeholder: None,
                    },
                },
            ))),
        );
        assert!(state.auth_flows.contains_key(&flow_id));
        assert!(matches!(
            state.view.overlay,
            Some(OverlayState::AuthenticationPrompt { .. })
        ));
    }

    #[test]
    fn extension_dialogs_are_queued_and_rendered_semantically() {
        let mut state = AppState::default();
        reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Event(
                BackendEvent::ExtensionUiRequested {
                    dialog_id: DialogId::parse("dialog-1").expect("dialog ID"),
                    request: ExtensionUiRequest::Confirm {
                        title: "Apply?".to_owned(),
                        message: "Mutate repository".to_owned(),
                    },
                },
            ))),
        );
        assert_eq!(state.dialogs.len(), 1);
        assert!(matches!(
            state.view.overlay,
            Some(OverlayState::ExtensionDialog { .. })
        ));
    }

    #[test]
    fn quit_waits_for_backend_termination() {
        let mut state = AppState::default();
        let effects = reduce(&mut state, AppEvent::User(UserIntent::Quit));
        assert!(state.exit_requested);
        assert!(!state.should_quit);
        assert!(effects.contains(&AppEffect::Send(BackendCommand::Shutdown)));

        let effects = reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Reply {
                request_id: phenix_runtime_api::RequestId::parse("shutdown").expect("request ID"),
                result: Ok(BackendReply::Completed),
            })),
        );
        assert!(!state.should_quit);
        assert!(!effects.contains(&AppEffect::Quit));

        let effects = reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Stopped { result: Ok(()) })),
        );
        assert!(state.should_quit);
        assert!(effects.contains(&AppEffect::Quit));
    }

    #[test]
    fn transcript_updates_replace_by_stable_identity() {
        let run = RunId::parse("root-run").expect("run ID");
        let mut state = state_with_run(run.clone());
        let block = TranscriptBlock {
            id: "assistant-1".to_owned(),
            run_id: run.clone(),
            role: TranscriptRole::Assistant,
            text: "partial".to_owned(),
            complete: false,
        };
        reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Event(
                BackendEvent::TranscriptAppended(block.clone()),
            ))),
        );
        reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Event(
                BackendEvent::TranscriptUpdated(TranscriptBlock {
                    text: "complete".to_owned(),
                    complete: true,
                    ..block
                }),
            ))),
        );
        let transcript = state.transcript(&run).expect("transcript");
        assert_eq!(transcript.blocks.len(), 1);
        assert_eq!(transcript.blocks[0].text, "complete");
    }

    #[test]
    fn rejected_operation_does_not_degrade_a_healthy_connection() {
        let mut state = AppState {
            connection: RuntimeConnectionState::Ready,
            ..AppState::default()
        };
        reduce(
            &mut state,
            AppEvent::Backend(Box::new(BackendOutput::Reply {
                request_id: phenix_runtime_api::RequestId::parse("request-1").expect("request ID"),
                result: Err(BackendError::Unsupported("no export".to_owned())),
            })),
        );
        assert_eq!(state.connection, RuntimeConnectionState::Ready);
        assert!(state
            .notifications
            .back()
            .is_some_and(|message| message.contains("no export")));
    }

    #[test]
    fn tool_lifecycle_uses_one_stable_transcript_block() {
        let run = RunId::parse("root-run").expect("run ID");
        let tool_call_id = phenix_runtime_api::ToolCallId::parse("tool-1").expect("tool ID");
        let mut state = state_with_run(run.clone());
        for event in [
            BackendEvent::ToolStarted {
                run_id: run.clone(),
                tool_call_id: tool_call_id.clone(),
                tool_name: "read".to_owned(),
                raw_input_json: r#"{"path":"file.rs"}"#.to_owned(),
                input_summary: "file.rs".to_owned(),
            },
            BackendEvent::ToolFinished {
                run_id: run.clone(),
                tool_call_id,
                outcome: ToolExecutionOutcome::Succeeded,
                output_summary: "done".to_owned(),
            },
        ] {
            reduce(
                &mut state,
                AppEvent::Backend(Box::new(BackendOutput::Event(event))),
            );
        }
        let transcript = state.transcript(&run).expect("transcript");
        assert_eq!(transcript.blocks.len(), 1);
        assert!(transcript.blocks[0].complete);
        assert!(transcript.blocks[0].text.contains("done"));
    }

    fn state_with_run(run: RunId) -> AppState {
        let mut state = AppState::default();
        state.root_run = Some(run.clone());
        state.selected_run = Some(run.clone());
        state.snapshot = Some(RuntimeSnapshot {
            capabilities: Default::default(),
            health: BackendHealth::Ready,
            active_session: None,
            root_run: Some(run.clone()),
            selected_run: Some(run.clone()),
            sessions: Vec::new(),
            runs: vec![RunSummary {
                id: run,
                parent: None,
                kind: RunKind::Root,
                definition_id: "root.session".to_owned(),
                display_name: "Root".to_owned(),
                state: RunState::Running,
                persisted_session: None,
                session_file: None,
                model: None,
                thinking_level: None,
                difficulty: None,
                budget: None,
                pending_messages: 0,
                outcome: None,
            }],
            objectives: Vec::new(),
        });
        state
    }
}
