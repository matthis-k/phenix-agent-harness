use crate::{
    BusReaction, EventConsumer, InputEdit, Propagation, ReactionBatch, UiEvent, ViewMutation,
};
use phenix_frontend_config::{
    ApplicationCommand, FrontendCommand, FrontendContext, FrontendProviderRef, InputCommand,
    OverlayCommand, PaneType, UiCommand,
};
use phenix_runtime_api::{
    AuthPrompt, AuthPromptResponse, ExtensionUiRequest, ExtensionUiResponse, SecretValue,
};
use phenix_ui_core::{
    AppEvent, AppState, ElementId, EventEnvelope, KeyCode, OverlayState, UiInput, UserIntent,
};

pub struct FrontendProviderConsumer {
    id: ElementId,
    provider: FrontendProviderRef,
}

impl FrontendProviderConsumer {
    pub fn new(provider: FrontendProviderRef) -> Self {
        Self {
            id: ElementId::root(),
            provider,
        }
    }
}

impl EventConsumer for FrontendProviderConsumer {
    fn element_id(&self) -> &ElementId {
        &self.id
    }

    fn on_ui(&mut self, state: &AppState, envelope: &EventEnvelope<UiEvent>) -> ReactionBatch {
        match &envelope.event {
            UiEvent::Input(UiInput::Paste(text)) if active_auth_terminal(state).is_some() => {
                let flow_id = active_auth_terminal(state).expect("checked active terminal");
                ReactionBatch::stop(vec![BusReaction::App(AppEvent::User(
                    UserIntent::WriteAuthenticationTerminal {
                        flow_id,
                        bytes: text.as_bytes().to_vec(),
                    },
                ))])
            }
            UiEvent::Input(UiInput::Key(key)) if active_auth_terminal(state).is_some() => {
                terminal_key_reactions(
                    active_auth_terminal(state).expect("checked active terminal"),
                    *key,
                )
            }
            UiEvent::Input(UiInput::Paste(text)) => ReactionBatch::stop(vec![BusReaction::View(
                ViewMutation::EditInput(InputEdit::Insert(text.clone())),
            )]),
            UiEvent::Input(UiInput::Key(key)) => {
                let context = frontend_context(state);
                match self.provider.borrow_mut().handle_key(&context, *key) {
                    Ok(commands) if !commands.is_empty() => ReactionBatch::stop(
                        commands
                            .into_iter()
                            .flat_map(|command| command_reactions(state, command))
                            .collect(),
                    ),
                    Ok(_) => fallback_key(*key),
                    Err(error) => ReactionBatch::stop(vec![BusReaction::View(
                        ViewMutation::Notify(format!("frontend configuration error: {error}")),
                    )]),
                }
            }
            UiEvent::Input(
                UiInput::Resize { .. }
                | UiInput::Mouse(_)
                | UiInput::FocusGained
                | UiInput::FocusLost,
            )
            | UiEvent::FocusRequested(_)
            | UiEvent::FocusMoveRequested(_)
            | UiEvent::ResizeRequested { .. }
            | UiEvent::VisibilityRequested { .. }
            | UiEvent::ScrollRequested { .. }
            | UiEvent::Invalidate
            | UiEvent::ShutdownRequested => ReactionBatch::none(),
        }
    }
}

pub fn install_frontend_provider(
    router: &mut crate::EventRouter,
    provider: FrontendProviderRef,
) -> Result<(), crate::RouterError> {
    router.register_consumer(Box::new(FrontendProviderConsumer::new(provider)))
}

fn active_auth_terminal(state: &AppState) -> Option<phenix_runtime_api::AuthFlowId> {
    match &state.view.overlay {
        Some(OverlayState::AuthenticationTerminal { flow_id }) => Some(flow_id.clone()),
        _ => None,
    }
}

fn terminal_key_reactions(
    flow_id: phenix_runtime_api::AuthFlowId,
    key: phenix_ui_core::KeyInput,
) -> ReactionBatch {
    if key.modifiers.control && key.code == KeyCode::Character(']') {
        return ReactionBatch::stop(vec![BusReaction::App(AppEvent::User(
            UserIntent::CancelAuthentication(flow_id),
        ))]);
    }
    terminal_key_bytes(key).map_or_else(ReactionBatch::none, |bytes| {
        ReactionBatch::stop(vec![BusReaction::App(AppEvent::User(
            UserIntent::WriteAuthenticationTerminal { flow_id, bytes },
        ))])
    })
}

fn terminal_key_bytes(key: phenix_ui_core::KeyInput) -> Option<Vec<u8>> {
    let mut bytes = match key.code {
        KeyCode::Character(character) if key.modifiers.control => {
            let upper = character.to_ascii_uppercase();
            if ('@'..='_').contains(&upper) {
                vec![(upper as u8) & 0x1f]
            } else if character == '?' {
                vec![0x7f]
            } else {
                return None;
            }
        }
        KeyCode::Character(character) => character.to_string().into_bytes(),
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Escape => vec![0x1b],
        KeyCode::Backspace => vec![0x7f],
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        KeyCode::Insert => b"\x1b[2~".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        KeyCode::Tab => vec![b'\t'],
        KeyCode::BackTab => b"\x1b[Z".to_vec(),
        KeyCode::Function(number) => match number {
            1 => b"\x1bOP".to_vec(),
            2 => b"\x1bOQ".to_vec(),
            3 => b"\x1bOR".to_vec(),
            4 => b"\x1bOS".to_vec(),
            5..=12 => format!("\x1b[{}~", number + 10).into_bytes(),
            _ => return None,
        },
    };
    if key.modifiers.alt {
        bytes.insert(0, 0x1b);
    }
    Some(bytes)
}

fn frontend_context(state: &AppState) -> FrontendContext {
    let focused_element = state.view.focus.element_id();
    let pane_type = if state.view.overlay.is_some() || !state.dialogs.is_empty() {
        PaneType::Overlay
    } else {
        PaneType::from_element(&focused_element)
    };
    FrontendContext {
        focused_element,
        pane_type,
        overlay_open: state.view.overlay.is_some(),
        dialog_open: !state.dialogs.is_empty(),
        input_empty: state.input.text.is_empty(),
        details_visible: state.view.show_details,
    }
}

fn command_reactions(state: &AppState, command: FrontendCommand) -> Vec<BusReaction> {
    match command {
        FrontendCommand::Application(command) => application_reactions(command),
        FrontendCommand::Ui(command) => ui_reactions(state, command),
        FrontendCommand::Input(command) => {
            vec![BusReaction::View(ViewMutation::EditInput(match command {
                InputCommand::Insert(text) => InputEdit::Insert(text),
                InputCommand::Backspace => InputEdit::Backspace,
                InputCommand::Delete => InputEdit::Delete,
                InputCommand::MoveLeft => InputEdit::MoveLeft,
                InputCommand::MoveRight => InputEdit::MoveRight,
                InputCommand::HistoryPrevious => InputEdit::HistoryPrevious,
                InputCommand::HistoryNext => InputEdit::HistoryNext,
            }))]
        }
        FrontendCommand::Overlay(command) => overlay_reactions(state, command),
        FrontendCommand::Handled => Vec::new(),
    }
}

fn application_reactions(command: ApplicationCommand) -> Vec<BusReaction> {
    let intent = match command {
        ApplicationCommand::Submit => UserIntent::SubmitPrompt,
        ApplicationCommand::Steer => UserIntent::SteerPrompt,
        ApplicationCommand::FollowUp => UserIntent::FollowUpPrompt,
        ApplicationCommand::Abort => UserIntent::Abort,
        ApplicationCommand::Quit => UserIntent::Quit,
        ApplicationCommand::OpenAuthentication => UserIntent::OpenAuthentication,
        ApplicationCommand::OpenModelPicker => UserIntent::OpenModelPicker,
        ApplicationCommand::OpenSessionPicker => UserIntent::OpenSessionPicker,
        ApplicationCommand::ToggleDetails => UserIntent::ToggleDetails,
        ApplicationCommand::CloseOverlay => UserIntent::CloseOverlay,
    };
    vec![BusReaction::App(AppEvent::User(intent))]
}

fn ui_reactions(state: &AppState, command: UiCommand) -> Vec<BusReaction> {
    match command {
        UiCommand::FocusSet(element) => vec![BusReaction::Ui(EventEnvelope::to(
            ElementId::root(),
            UiEvent::FocusRequested(element),
        ))],
        UiCommand::FocusMove(direction) => vec![BusReaction::Ui(EventEnvelope::to(
            ElementId::root(),
            UiEvent::FocusMoveRequested(direction),
        ))],
        UiCommand::PaneResize {
            element,
            axis,
            request,
        } => vec![BusReaction::Ui(EventEnvelope::to(
            ElementId::layout(),
            UiEvent::ResizeRequested {
                element,
                axis,
                request,
            },
        ))],
        UiCommand::PaneVisibility { element, visible } => vec![BusReaction::Ui(EventEnvelope::to(
            ElementId::layout(),
            UiEvent::VisibilityRequested { element, visible },
        ))],
        UiCommand::PaneToggle(element) => {
            let visible = !state.view.pane(&element).visible;
            vec![BusReaction::Ui(EventEnvelope::to(
                ElementId::layout(),
                UiEvent::VisibilityRequested { element, visible },
            ))]
        }
        UiCommand::PaneScroll { element, lines } => vec![BusReaction::Ui(EventEnvelope::to(
            element.clone(),
            UiEvent::ScrollRequested { element, lines },
        ))],
        UiCommand::Invalidate => vec![BusReaction::Render],
    }
}

fn overlay_reactions(state: &AppState, command: OverlayCommand) -> Vec<BusReaction> {
    match command {
        OverlayCommand::MoveSelection(delta) => {
            vec![BusReaction::View(ViewMutation::MoveOverlaySelection(delta))]
        }
        OverlayCommand::Accept => accept_overlay(state),
        OverlayCommand::Cancel => cancel_overlay(state),
    }
}

fn accept_overlay(state: &AppState) -> Vec<BusReaction> {
    if let Some(dialog) = state.dialogs.front() {
        let selected = overlay_selected(state);
        let response = match &dialog.request {
            ExtensionUiRequest::Select { options, .. } => options
                .get(selected)
                .or_else(|| options.first())
                .cloned()
                .map_or(
                    ExtensionUiResponse::Cancelled,
                    ExtensionUiResponse::Selected,
                ),
            ExtensionUiRequest::Confirm { .. } => ExtensionUiResponse::Confirmed(true),
            ExtensionUiRequest::Input { .. } | ExtensionUiRequest::Editor { .. } => {
                ExtensionUiResponse::Text(state.input.text.clone())
            }
        };
        return vec![
            BusReaction::App(AppEvent::User(UserIntent::InputChanged(String::new()))),
            BusReaction::App(AppEvent::User(UserIntent::RespondToDialog(response))),
        ];
    }

    match &state.view.overlay {
        Some(OverlayState::ModelPicker { selected, .. }) => state
            .models
            .get(*selected)
            .or_else(|| state.models.first())
            .map_or_else(Vec::new, |model| {
                vec![BusReaction::App(AppEvent::User(UserIntent::SelectModel(
                    model.model.clone(),
                )))]
            }),
        Some(OverlayState::AuthenticationProviders { selected, .. }) => state
            .auth_providers
            .get(*selected)
            .or_else(|| state.auth_providers.first())
            .and_then(|provider| {
                provider.methods.first().map(|method| {
                    BusReaction::App(AppEvent::User(UserIntent::StartAuthentication {
                        provider_id: provider.id.clone(),
                        method: method.clone(),
                    }))
                })
            })
            .into_iter()
            .collect(),
        Some(OverlayState::AuthenticationPrompt {
            flow_id,
            prompt,
            selected,
            ..
        }) => vec![
            BusReaction::App(AppEvent::User(UserIntent::InputChanged(String::new()))),
            BusReaction::App(AppEvent::User(UserIntent::RespondToAuthentication {
                flow_id: flow_id.clone(),
                response: auth_response(prompt, &state.input.text, *selected),
            })),
        ],
        Some(OverlayState::SessionPicker { selected, .. }) => state
            .snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .sessions
                    .get(*selected)
                    .or_else(|| snapshot.sessions.first())
            })
            .map_or_else(Vec::new, |session| {
                vec![BusReaction::App(AppEvent::User(UserIntent::SwitchSession(
                    session.id.clone(),
                )))]
            }),
        Some(OverlayState::AuthenticationTerminal { .. })
        | Some(OverlayState::ExtensionDialog { .. }) => Vec::new(),
        Some(OverlayState::CommandPalette { .. }) | Some(OverlayState::Help) | None => Vec::new(),
    }
}

fn cancel_overlay(state: &AppState) -> Vec<BusReaction> {
    if !state.dialogs.is_empty() {
        return vec![BusReaction::App(AppEvent::User(
            UserIntent::RespondToDialog(ExtensionUiResponse::Cancelled),
        ))];
    }
    if let Some(
        OverlayState::AuthenticationPrompt { flow_id, .. }
        | OverlayState::AuthenticationTerminal { flow_id },
    ) = &state.view.overlay
    {
        return vec![BusReaction::App(AppEvent::User(
            UserIntent::CancelAuthentication(flow_id.clone()),
        ))];
    }
    vec![BusReaction::App(AppEvent::User(UserIntent::CloseOverlay))]
}

fn auth_response(prompt: &AuthPrompt, text: &str, selected: usize) -> AuthPromptResponse {
    match prompt {
        AuthPrompt::Text { .. } => AuthPromptResponse::Text(text.to_owned()),
        AuthPrompt::Secret { .. } => AuthPromptResponse::Secret(SecretValue::from_utf8(text)),
        AuthPrompt::ManualCode { .. } => AuthPromptResponse::ManualCode(text.to_owned()),
        AuthPrompt::Select { options, .. } => options
            .get(selected)
            .or_else(|| options.first())
            .map_or(AuthPromptResponse::Cancelled, |option| {
                AuthPromptResponse::Selected(option.id.clone())
            }),
    }
}

fn overlay_selected(state: &AppState) -> usize {
    match &state.view.overlay {
        Some(OverlayState::CommandPalette { selected, .. })
        | Some(OverlayState::ModelPicker { selected, .. })
        | Some(OverlayState::AuthenticationProviders { selected, .. })
        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
        | Some(OverlayState::ExtensionDialog { selected, .. }) => *selected,
        Some(OverlayState::AuthenticationTerminal { .. }) | Some(OverlayState::Help) | None => 0,
    }
}

fn fallback_key(key: phenix_ui_core::KeyInput) -> ReactionBatch {
    match key.code {
        KeyCode::Character(character) if !key.modifiers.control && !key.modifiers.alt => {
            ReactionBatch::stop(vec![BusReaction::View(ViewMutation::EditInput(
                InputEdit::Insert(character.to_string()),
            ))])
        }
        _ => ReactionBatch {
            reactions: Vec::new(),
            propagation: Propagation::Continue,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_frontend_config::{FrontendConfig, FrontendConfigProvider, FrontendProviderError};
    use phenix_ui_core::{KeyInput, KeyModifiers};
    use std::cell::RefCell;
    use std::path::Path;
    use std::rc::Rc;

    struct FakeProvider;

    impl FrontendConfigProvider for FakeProvider {
        fn config(&self) -> &FrontendConfig {
            static CONFIG: std::sync::OnceLock<FrontendConfig> = std::sync::OnceLock::new();
            CONFIG.get_or_init(FrontendConfig::default)
        }

        fn handle_key(
            &mut self,
            _context: &FrontendContext,
            input: KeyInput,
        ) -> Result<Vec<FrontendCommand>, FrontendProviderError> {
            Ok((input.code == KeyCode::Character('x'))
                .then_some(FrontendCommand::Ui(UiCommand::FocusSet(
                    ElementId::sidebar(),
                )))
                .into_iter()
                .collect())
        }

        fn reload(&mut self) -> Result<(), FrontendProviderError> {
            Ok(())
        }

        fn source_path(&self) -> Option<&Path> {
            None
        }
    }

    #[test]
    fn provider_commands_are_translated_without_a_backend() {
        let provider: FrontendProviderRef = Rc::new(RefCell::new(FakeProvider));
        let mut consumer = FrontendProviderConsumer::new(provider);
        let reactions = consumer.on_ui(
            &AppState::default(),
            &EventEnvelope::focused(UiEvent::Input(UiInput::Key(KeyInput {
                code: KeyCode::Character('x'),
                modifiers: KeyModifiers::default(),
                repeat: false,
            }))),
        );
        assert!(matches!(
            reactions.reactions.as_slice(),
            [BusReaction::Ui(EventEnvelope {
                event: UiEvent::FocusRequested(element),
                ..
            })] if element == &ElementId::sidebar()
        ));
    }
}
