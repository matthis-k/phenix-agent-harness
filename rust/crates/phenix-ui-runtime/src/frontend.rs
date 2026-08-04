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

    fn on_ui(
        &mut self,
        state: &AppState,
        envelope: &EventEnvelope<UiEvent>,
    ) -> ReactionBatch {
        match &envelope.event {
            UiEvent::Input(UiInput::Paste(text)) => ReactionBatch::stop(vec![
                BusReaction::View(ViewMutation::EditInput(InputEdit::Insert(text.clone()))),
            ]),
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
                        ViewMutation::Notify(format!(
                            "frontend configuration error: {error}"
                        )),
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
        FrontendCommand::Input(command) => vec![BusReaction::View(ViewMutation::EditInput(
            match command {
                InputCommand::Insert(text) => InputEdit::Insert(text),
                InputCommand::Backspace => InputEdit::Backspace,
                InputCommand::Delete => InputEdit::Delete,
                InputCommand::MoveLeft => InputEdit::MoveLeft,
                InputCommand::MoveRight => InputEdit::MoveRight,
                InputCommand::HistoryPrevious => InputEdit::HistoryPrevious,
                InputCommand::HistoryNext => InputEdit::HistoryNext,
            },
        ))],
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
        UiCommand::PaneVisibility { element, visible } => vec![BusReaction::Ui(
            EventEnvelope::to(
                ElementId::layout(),
                UiEvent::VisibilityRequested { element, visible },
            ),
        )],
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
                .map_or(ExtensionUiResponse::Cancelled, ExtensionUiResponse::Selected),
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
        Some(OverlayState::ExtensionDialog { .. }) => Vec::new(),
        Some(OverlayState::CommandPalette { .. }) | Some(OverlayState::Help) | None => Vec::new(),
    }
}

fn cancel_overlay(state: &AppState) -> Vec<BusReaction> {
    if !state.dialogs.is_empty() {
        return vec![BusReaction::App(AppEvent::User(UserIntent::RespondToDialog(
            ExtensionUiResponse::Cancelled,
        )))];
    }
    if let Some(OverlayState::AuthenticationPrompt { flow_id, .. }) = &state.view.overlay {
        return vec![BusReaction::App(AppEvent::User(
            UserIntent::CancelAuthentication(flow_id.clone()),
        ))];
    }
    vec![BusReaction::App(AppEvent::User(UserIntent::CloseOverlay))]
}

fn auth_response(prompt: &AuthPrompt, text: &str, selected: usize) -> AuthPromptResponse {
    match prompt {
        AuthPrompt::Text { .. } => AuthPromptResponse::Text(text.to_owned()),
        AuthPrompt::Secret { .. } => {
            AuthPromptResponse::Secret(SecretValue::from_utf8(text))
        }
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
        Some(OverlayState::Help) | None => 0,
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
                .then_some(FrontendCommand::Ui(UiCommand::FocusSet(ElementId::sidebar())))
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
