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
    selected_command_completion, AppEvent, AppState, ElementId, EventEnvelope, FocusTarget,
    InputEditor, KeyCode, KeyInput, OverlayState, UiInput, UserIntent, VimMode,
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
            UiEvent::Input(UiInput::Paste(text)) => {
                if state.view.focus == FocusTarget::Input
                    || state.view.overlay.is_some()
                    || !state.dialogs.is_empty()
                {
                    ReactionBatch::stop(vec![BusReaction::View(ViewMutation::EditInput(
                        InputEdit::Insert(text.clone()),
                    ))])
                } else {
                    ReactionBatch::none()
                }
            }
            UiEvent::Input(UiInput::Key(key)) => {
                let context = frontend_context(state);
                match self.provider.borrow_mut().handle_key(&context, *key) {
                    Ok(commands) if !commands.is_empty() => ReactionBatch::stop(
                        commands
                            .into_iter()
                            .flat_map(|command| command_reactions(state, command))
                            .collect(),
                    ),
                    Ok(_) => fallback_key(state, *key),
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

fn frontend_context(state: &AppState) -> FrontendContext {
    let focused_element = state.view.focus.element_id();
    let passive_completion = matches!(
        state.view.overlay,
        Some(OverlayState::CommandPalette { .. })
    );
    let pane_type =
        if (state.view.overlay.is_some() && !passive_completion) || !state.dialogs.is_empty() {
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
        input_insert_mode: state.view.focus == FocusTarget::Input
            && state.view.vim_mode == VimMode::Insert,
        details_visible: state.view.show_details,
    }
}

fn command_reactions(state: &AppState, command: FrontendCommand) -> Vec<BusReaction> {
    match command {
        FrontendCommand::Application(command) => application_reactions(state, command),
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

fn application_reactions(state: &AppState, command: ApplicationCommand) -> Vec<BusReaction> {
    let intent = match command {
        ApplicationCommand::Submit => Some(UserIntent::SubmitPrompt),
        ApplicationCommand::Steer => Some(UserIntent::SteerPrompt),
        ApplicationCommand::FollowUp => Some(UserIntent::FollowUpPrompt),
        ApplicationCommand::Abort => Some(UserIntent::Abort),
        ApplicationCommand::Quit => Some(UserIntent::Quit),
        ApplicationCommand::OpenAuthentication => Some(UserIntent::OpenAuthentication),
        ApplicationCommand::OpenModelPicker => Some(UserIntent::OpenModelPicker),
        ApplicationCommand::OpenSessionPicker => Some(UserIntent::OpenSessionPicker),
        ApplicationCommand::CreateSession => Some(UserIntent::CreateSession),
        ApplicationCommand::MoveRun(delta) => state
            .input_target()
            .and_then(|run_id| state.visible_run_neighbor(run_id, delta))
            .map(UserIntent::SelectRun),
        ApplicationCommand::ActivateSidebarRun => {
            state.sidebar_cursor_run_id().map(UserIntent::SelectRun)
        }
        ApplicationCommand::MoveSession(delta) => {
            session_neighbor(state, delta).map(UserIntent::SwitchSession)
        }
        ApplicationCommand::ToggleDetails => Some(UserIntent::ToggleDetails),
        ApplicationCommand::CloseOverlay => Some(UserIntent::CloseOverlay),
    };
    intent
        .map(|intent| vec![BusReaction::App(AppEvent::User(intent))])
        .unwrap_or_default()
}

fn session_neighbor(state: &AppState, delta: i32) -> Option<phenix_runtime_api::SessionId> {
    let sessions = &state.snapshot.as_ref()?.sessions;
    if sessions.is_empty() {
        return None;
    }
    let current = state
        .active_session
        .as_ref()
        .and_then(|active| sessions.iter().position(|session| &session.id == active))
        .unwrap_or(0);
    let length = i64::try_from(sessions.len()).ok()?;
    let next = (i64::try_from(current).ok()? + i64::from(delta)).rem_euclid(length);
    sessions
        .get(usize::try_from(next).ok()?)
        .map(|session| session.id.clone())
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
        UiCommand::SidebarRunMove(delta) => {
            vec![BusReaction::View(ViewMutation::MoveSidebarRun(delta))]
        }
        UiCommand::SidebarRunParent => {
            vec![BusReaction::View(ViewMutation::MoveSidebarRunParent)]
        }
        UiCommand::SidebarRunChild => {
            vec![BusReaction::View(ViewMutation::MoveSidebarRunChild)]
        }
        UiCommand::SidebarRunToggle => vec![BusReaction::View(ViewMutation::ToggleSidebarRun)],
        UiCommand::TranscriptTurnMove(delta) => {
            vec![BusReaction::View(ViewMutation::MoveTranscriptTurn(delta))]
        }
        UiCommand::TranscriptFoldMove(delta) => {
            vec![BusReaction::View(ViewMutation::MoveTranscriptFold(delta))]
        }
        UiCommand::TranscriptFoldSetExpanded(expanded) => {
            vec![BusReaction::View(ViewMutation::SetTranscriptFoldExpanded(
                expanded,
            ))]
        }
        UiCommand::TranscriptFoldToggle => {
            vec![BusReaction::View(ViewMutation::ToggleTranscriptFold)]
        }
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
        Some(OverlayState::CommandPalette { selected, .. }) => {
            selected_command_completion(state, *selected).map_or_else(Vec::new, |completion| {
                vec![
                    BusReaction::App(AppEvent::User(UserIntent::InputChanged(completion.command))),
                    BusReaction::App(AppEvent::User(UserIntent::CloseOverlay)),
                ]
            })
        }
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
        Some(OverlayState::Help) | None => Vec::new(),
    }
}

fn cancel_overlay(state: &AppState) -> Vec<BusReaction> {
    if !state.dialogs.is_empty() {
        return vec![BusReaction::App(AppEvent::User(
            UserIntent::RespondToDialog(ExtensionUiResponse::Cancelled),
        ))];
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
        Some(OverlayState::Help) | None => 0,
    }
}

fn fallback_key(state: &AppState, key: KeyInput) -> ReactionBatch {
    if matches!(
        state.view.overlay,
        Some(OverlayState::CommandPalette { .. })
    ) {
        if let Some(reactions) = command_completion_key(state, key) {
            return stop_with(reactions);
        }
    } else if state.view.overlay.is_some() || !state.dialogs.is_empty() {
        return continue_propagation();
    }

    if state.view.focus != FocusTarget::Input {
        return match key.code {
            KeyCode::Escape => stop_with(Vec::new()),
            _ => continue_propagation(),
        };
    }
    if key.modifiers.control && key.code == KeyCode::Character('g') {
        return open_external_editor();
    }
    if key.modifiers.control && key.code == KeyCode::Character('e') {
        return cycle_editor(state.view.input_editor);
    }

    match state.view.input_editor {
        InputEditor::External => external_editor_key(key),
        InputEditor::Owned | InputEditor::Embedded => match state.view.vim_mode {
            VimMode::Normal => normal_mode_key(state.view.input_editor, key),
            VimMode::Insert => insert_mode_key(state, state.view.input_editor, key),
        },
    }
}

fn command_completion_key(state: &AppState, key: KeyInput) -> Option<Vec<BusReaction>> {
    let navigate = match key.code {
        KeyCode::Up if !key.modifiers.control && !key.modifiers.alt => Some(-1),
        KeyCode::Down if !key.modifiers.control && !key.modifiers.alt => Some(1),
        KeyCode::Character('p') if key.modifiers.control && !key.modifiers.alt => Some(-1),
        KeyCode::Character('n') if key.modifiers.control && !key.modifiers.alt => Some(1),
        _ => None,
    };
    if let Some(delta) = navigate {
        return Some(vec![BusReaction::View(ViewMutation::MoveOverlaySelection(
            delta,
        ))]);
    }
    let plain_enter = key.code == KeyCode::Enter
        && !key.modifiers.shift
        && !key.modifiers.control
        && !key.modifiers.alt;
    let ctrl_y = key.code == KeyCode::Character('y') && key.modifiers.control && !key.modifiers.alt;
    if plain_enter || ctrl_y {
        return Some(accept_overlay(state));
    }
    None
}

fn open_external_editor() -> ReactionBatch {
    stop_with(vec![
        edit_input(InputEdit::SetEditor(InputEditor::External)),
        BusReaction::ExternalEditor,
    ])
}

fn cycle_editor(current: InputEditor) -> ReactionBatch {
    let next = current.next();
    let mut reactions = vec![edit_input(InputEdit::SetEditor(next))];
    if next == InputEditor::External {
        reactions.push(BusReaction::ExternalEditor);
    }
    stop_with(reactions)
}

fn external_editor_key(key: KeyInput) -> ReactionBatch {
    match key.code {
        KeyCode::Escape => stop_with(vec![edit_input(InputEdit::SetEditor(InputEditor::Owned))]),
        KeyCode::Enter if key.modifiers.control => {
            stop_with(vec![application_intent(UserIntent::SubmitPrompt)])
        }
        KeyCode::Enter => stop_with(vec![BusReaction::ExternalEditor]),
        KeyCode::Character('i' | 'a' | 'e') if !key.modifiers.control && !key.modifiers.alt => {
            stop_with(vec![BusReaction::ExternalEditor])
        }
        _ => continue_propagation(),
    }
}

fn normal_mode_key(editor: InputEditor, key: KeyInput) -> ReactionBatch {
    if key.modifiers.alt && key.code == KeyCode::Enter {
        return stop_with(vec![application_intent(UserIntent::FollowUpPrompt)]);
    }
    if key.modifiers.control && key.code == KeyCode::Enter {
        return stop_with(vec![application_intent(UserIntent::SteerPrompt)]);
    }
    match key.code {
        KeyCode::Escape => stop_with(Vec::new()),
        KeyCode::Enter => stop_with(vec![application_intent(UserIntent::SubmitPrompt)]),
        KeyCode::Left | KeyCode::Character('h') => stop_with(vec![edit_input(InputEdit::MoveLeft)]),
        KeyCode::Right | KeyCode::Character('l') => {
            stop_with(vec![edit_input(InputEdit::MoveRight)])
        }
        KeyCode::Up | KeyCode::Character('k') => stop_with(vec![edit_input(match editor {
            InputEditor::Owned => InputEdit::HistoryPrevious,
            InputEditor::Embedded => InputEdit::MoveUp,
            InputEditor::External => unreachable!("external editor handled separately"),
        })]),
        KeyCode::Down | KeyCode::Character('j') => stop_with(vec![edit_input(match editor {
            InputEditor::Owned => InputEdit::HistoryNext,
            InputEditor::Embedded => InputEdit::MoveDown,
            InputEditor::External => unreachable!("external editor handled separately"),
        })]),
        KeyCode::Home | KeyCode::Character('0') => stop_with(vec![edit_input(InputEdit::MoveHome)]),
        KeyCode::End | KeyCode::Character('$') => stop_with(vec![edit_input(InputEdit::MoveEnd)]),
        KeyCode::Character('w') => stop_with(vec![edit_input(InputEdit::MoveWordForward)]),
        KeyCode::Character('b') => stop_with(vec![edit_input(InputEdit::MoveWordBackward)]),
        KeyCode::Delete | KeyCode::Character('x') => stop_with(vec![edit_input(InputEdit::Delete)]),
        KeyCode::Character('D') => stop_with(vec![edit_input(InputEdit::DeleteLine)]),
        KeyCode::Character('i') => {
            stop_with(vec![edit_input(InputEdit::SetVimMode(VimMode::Insert))])
        }
        KeyCode::Character('a') => stop_with(vec![
            edit_input(InputEdit::MoveRight),
            edit_input(InputEdit::SetVimMode(VimMode::Insert)),
        ]),
        KeyCode::Character('I') => stop_with(vec![
            edit_input(InputEdit::MoveHome),
            edit_input(InputEdit::SetVimMode(VimMode::Insert)),
        ]),
        KeyCode::Character('A') => stop_with(vec![
            edit_input(InputEdit::MoveEnd),
            edit_input(InputEdit::SetVimMode(VimMode::Insert)),
        ]),
        KeyCode::Character('o') => stop_with(vec![
            edit_input(InputEdit::MoveEnd),
            edit_input(InputEdit::Insert("\n".to_owned())),
            edit_input(InputEdit::SetVimMode(VimMode::Insert)),
        ]),
        _ => continue_propagation(),
    }
}

fn insert_mode_key(state: &AppState, editor: InputEditor, key: KeyInput) -> ReactionBatch {
    if key.code == KeyCode::Escape {
        return stop_with(vec![edit_input(InputEdit::SetVimMode(VimMode::Normal))]);
    }
    if key.modifiers.alt && key.code == KeyCode::Enter {
        return stop_with(vec![application_intent(UserIntent::FollowUpPrompt)]);
    }
    if key.modifiers.control && key.code == KeyCode::Enter {
        return stop_with(vec![application_intent(match editor {
            InputEditor::Owned => UserIntent::SteerPrompt,
            InputEditor::Embedded => UserIntent::SubmitPrompt,
            InputEditor::External => unreachable!("external editor handled separately"),
        })]);
    }
    if editor == InputEditor::Owned && key.modifiers.control {
        if let Some(reactions) = owned_terminal_edit_key(state, key.code) {
            return stop_with(reactions);
        }
    }
    match key.code {
        KeyCode::Enter if key.modifiers.shift || editor == InputEditor::Embedded => {
            stop_with(vec![edit_input(InputEdit::Insert("\n".to_owned()))])
        }
        KeyCode::Enter => stop_with(vec![application_intent(UserIntent::SubmitPrompt)]),
        KeyCode::Backspace => stop_with(vec![edit_input(InputEdit::Backspace)]),
        KeyCode::Delete => stop_with(vec![edit_input(InputEdit::Delete)]),
        KeyCode::Left => stop_with(vec![edit_input(InputEdit::MoveLeft)]),
        KeyCode::Right => stop_with(vec![edit_input(InputEdit::MoveRight)]),
        KeyCode::Home => stop_with(vec![edit_input(InputEdit::MoveHome)]),
        KeyCode::End => stop_with(vec![edit_input(InputEdit::MoveEnd)]),
        KeyCode::Up => stop_with(vec![edit_input(match editor {
            InputEditor::Owned => InputEdit::HistoryPrevious,
            InputEditor::Embedded => InputEdit::MoveUp,
            InputEditor::External => unreachable!("external editor handled separately"),
        })]),
        KeyCode::Down => stop_with(vec![edit_input(match editor {
            InputEditor::Owned => InputEdit::HistoryNext,
            InputEditor::Embedded => InputEdit::MoveDown,
            InputEditor::External => unreachable!("external editor handled separately"),
        })]),
        KeyCode::Tab => stop_with(vec![edit_input(InputEdit::Insert("  ".to_owned()))]),
        KeyCode::Character(character) if !key.modifiers.control && !key.modifiers.alt => {
            stop_with(vec![edit_input(InputEdit::Insert(character.to_string()))])
        }
        _ => continue_propagation(),
    }
}

fn owned_terminal_edit_key(state: &AppState, code: KeyCode) -> Option<Vec<BusReaction>> {
    let reactions = match code {
        KeyCode::Character('a') => vec![edit_input(InputEdit::MoveHome)],
        KeyCode::Character('f') => vec![edit_input(InputEdit::MoveRight)],
        KeyCode::Character('h') => vec![edit_input(InputEdit::Backspace)],
        KeyCode::Character('p') => vec![edit_input(InputEdit::HistoryPrevious)],
        KeyCode::Character('n') => vec![edit_input(InputEdit::HistoryNext)],
        KeyCode::Character('w') => erase_before_cursor(state, EraseBoundary::PreviousWord),
        KeyCode::Character('u') => erase_before_cursor(state, EraseBoundary::LineStart),
        KeyCode::Character('k') => erase_after_cursor(state),
        _ => return None,
    };
    Some(reactions)
}

#[derive(Clone, Copy)]
enum EraseBoundary {
    PreviousWord,
    LineStart,
}

fn erase_before_cursor(state: &AppState, boundary: EraseBoundary) -> Vec<BusReaction> {
    let original = state.input.cursor_byte.min(state.input.text.len());
    let mut probe = state.input.clone();
    match boundary {
        EraseBoundary::PreviousWord => probe.move_word_backward(),
        EraseBoundary::LineStart => probe.move_home(),
    }
    let count = state.input.text[probe.cursor_byte..original]
        .chars()
        .count();
    std::iter::repeat_with(|| edit_input(InputEdit::Backspace))
        .take(count)
        .collect()
}

fn erase_after_cursor(state: &AppState) -> Vec<BusReaction> {
    let original = state.input.cursor_byte.min(state.input.text.len());
    let mut probe = state.input.clone();
    probe.move_end();
    let count = state.input.text[original..probe.cursor_byte]
        .chars()
        .count();
    std::iter::repeat_with(|| edit_input(InputEdit::Delete))
        .take(count)
        .collect()
}

fn edit_input(edit: InputEdit) -> BusReaction {
    BusReaction::View(ViewMutation::EditInput(edit))
}

fn application_intent(intent: UserIntent) -> BusReaction {
    BusReaction::App(AppEvent::User(intent))
}

fn stop_with(reactions: Vec<BusReaction>) -> ReactionBatch {
    ReactionBatch::stop(reactions)
}

fn continue_propagation() -> ReactionBatch {
    ReactionBatch {
        reactions: Vec::new(),
        propagation: Propagation::Continue,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_frontend_config::{FrontendConfig, FrontendConfigProvider, FrontendProviderError};
    use phenix_runtime_api::{
        BackendCapabilities, BackendHealth, PersistedSessionSummary, RunKind, RunState, RunSummary,
        RuntimeSnapshot, SessionId,
    };
    use phenix_ui_core::{KeyModifiers, ViewState};
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

    fn key(code: KeyCode) -> KeyInput {
        KeyInput {
            code,
            modifiers: KeyModifiers::default(),
            repeat: false,
        }
    }

    fn control_key(character: char) -> KeyInput {
        KeyInput {
            code: KeyCode::Character(character),
            modifiers: KeyModifiers {
                control: true,
                ..KeyModifiers::default()
            },
            repeat: false,
        }
    }

    fn shift_key(code: KeyCode) -> KeyInput {
        KeyInput {
            code,
            modifiers: KeyModifiers {
                shift: true,
                ..KeyModifiers::default()
            },
            repeat: false,
        }
    }

    fn run(id: &str, parent: Option<&str>) -> RunSummary {
        RunSummary {
            id: phenix_runtime_api::RunId::parse(id).expect("run id"),
            parent: parent.map(|parent| phenix_runtime_api::RunId::parse(parent).expect("parent")),
            kind: RunKind::Agent,
            definition_id: id.to_owned(),
            display_name: id.to_owned(),
            state: RunState::Running,
            persisted_session: None,
            session_file: None,
            model: None,
            thinking_level: None,
            difficulty: None,
            budget: None,
            pending_messages: 0,
            outcome: None,
        }
    }

    #[test]
    fn provider_commands_are_translated_without_a_backend() {
        let provider: FrontendProviderRef = Rc::new(RefCell::new(FakeProvider));
        let mut consumer = FrontendProviderConsumer::new(provider);
        let reactions = consumer.on_ui(
            &AppState::default(),
            &EventEnvelope::focused(UiEvent::Input(UiInput::Key(key(KeyCode::Character('x'))))),
        );
        assert!(matches!(
            reactions.reactions.as_slice(),
            [BusReaction::Ui(EventEnvelope {
                event: UiEvent::FocusRequested(element),
                ..
            })] if element == &ElementId::sidebar()
        ));
    }

    #[test]
    fn semantic_run_and_session_navigation_resolves_against_state() {
        let session_a = SessionId::parse("session-a").expect("session");
        let session_b = SessionId::parse("session-b").expect("session");
        let root = phenix_runtime_api::RunId::parse("root").expect("root");
        let child = phenix_runtime_api::RunId::parse("child").expect("child");
        let mut state = AppState::default();
        state.apply_snapshot(RuntimeSnapshot {
            capabilities: BackendCapabilities::default(),
            health: BackendHealth::Ready,
            active_session: Some(session_a.clone()),
            root_run: Some(root.clone()),
            selected_run: Some(root.clone()),
            sessions: vec![
                PersistedSessionSummary {
                    id: session_a,
                    name: None,
                    session_file: None,
                    cwd: None,
                    root_run_id: Some(root.clone()),
                    updated_at: None,
                },
                PersistedSessionSummary {
                    id: session_b.clone(),
                    name: None,
                    session_file: None,
                    cwd: None,
                    root_run_id: None,
                    updated_at: None,
                },
            ],
            runs: vec![run("root", None), run("child", Some("root"))],
            objectives: Vec::new(),
        });

        assert_eq!(
            application_reactions(&state, ApplicationCommand::MoveRun(1)),
            vec![BusReaction::App(AppEvent::User(UserIntent::SelectRun(
                child
            )))]
        );
        assert_eq!(
            application_reactions(&state, ApplicationCommand::MoveSession(1)),
            vec![BusReaction::App(AppEvent::User(UserIntent::SwitchSession(
                session_b
            )))]
        );
    }

    #[test]
    fn command_completion_keeps_input_context() {
        let mut state = AppState::default();
        state.input.replace("/mo".to_owned());
        state.view.overlay = Some(OverlayState::CommandPalette {
            query: "/mo".to_owned(),
            selected: 0,
        });
        let context = frontend_context(&state);
        assert_eq!(context.pane_type, PaneType::Input);
        assert!(context.input_insert_mode);
    }

    #[test]
    fn command_completion_only_intercepts_navigation_and_plain_acceptance() {
        let mut state = AppState::default();
        state.input.replace("/mo".to_owned());
        state.view.overlay = Some(OverlayState::CommandPalette {
            query: "/mo".to_owned(),
            selected: 0,
        });

        let typed = fallback_key(&state, key(KeyCode::Character('x')));
        assert_eq!(
            typed.reactions,
            vec![edit_input(InputEdit::Insert("x".to_owned()))]
        );

        let down = fallback_key(&state, key(KeyCode::Down));
        assert_eq!(
            down.reactions,
            vec![BusReaction::View(ViewMutation::MoveOverlaySelection(1))]
        );

        let ctrl_n = fallback_key(&state, control_key('n'));
        assert_eq!(
            ctrl_n.reactions,
            vec![BusReaction::View(ViewMutation::MoveOverlaySelection(1))]
        );

        let accepted = fallback_key(&state, control_key('y'));
        assert!(matches!(
            accepted.reactions.as_slice(),
            [
                BusReaction::App(AppEvent::User(UserIntent::InputChanged(_))),
                BusReaction::App(AppEvent::User(UserIntent::CloseOverlay))
            ]
        ));

        let newline = fallback_key(&state, shift_key(KeyCode::Enter));
        assert_eq!(
            newline.reactions,
            vec![edit_input(InputEdit::Insert("\n".to_owned()))]
        );
    }

    #[test]
    fn escape_only_changes_or_cancels_ui_mode() {
        let state = AppState::default();
        let reactions = fallback_key(&state, key(KeyCode::Escape));
        assert_eq!(
            reactions.reactions,
            vec![edit_input(InputEdit::SetVimMode(VimMode::Normal))]
        );

        let mut state = AppState::default();
        state.view.vim_mode = VimMode::Normal;
        let reactions = fallback_key(&state, key(KeyCode::Escape));
        assert!(reactions.reactions.is_empty());
        assert_eq!(reactions.propagation, Propagation::Stop);

        state.view.focus = FocusTarget::Transcript;
        let reactions = fallback_key(&state, key(KeyCode::Escape));
        assert!(reactions.reactions.is_empty());
        assert_eq!(reactions.propagation, Propagation::Stop);
    }

    #[test]
    fn owned_insert_mode_supports_terminal_word_and_line_erasure() {
        let mut state = AppState::default();
        state.input.replace("hello wide world".to_owned());

        let word = fallback_key(&state, control_key('w'));
        assert_eq!(word.reactions.len(), 5);
        assert!(word.reactions.iter().all(|reaction| {
            matches!(
                reaction,
                BusReaction::View(ViewMutation::EditInput(InputEdit::Backspace))
            )
        }));

        let line = fallback_key(&state, control_key('u'));
        assert_eq!(line.reactions.len(), state.input.text.chars().count());
        assert!(line.reactions.iter().all(|reaction| {
            matches!(
                reaction,
                BusReaction::View(ViewMutation::EditInput(InputEdit::Backspace))
            )
        }));
    }

    #[test]
    fn ctrl_g_always_opens_the_external_editor() {
        let reactions = fallback_key(&AppState::default(), control_key('g'));
        assert_eq!(
            reactions.reactions,
            vec![
                edit_input(InputEdit::SetEditor(InputEditor::External)),
                BusReaction::ExternalEditor,
            ]
        );
    }

    #[test]
    fn editor_cycle_opens_external_editor_only_for_external_mode() {
        let reactions = cycle_editor(InputEditor::Embedded);
        assert_eq!(
            reactions.reactions,
            vec![
                edit_input(InputEdit::SetEditor(InputEditor::External)),
                BusReaction::ExternalEditor,
            ]
        );
        assert_eq!(ViewState::default().input_editor, InputEditor::Owned);
    }

    #[test]
    fn accepting_command_completion_inserts_the_selected_command() {
        let mut state = AppState::default();
        state.input.replace("/mo".to_owned());
        state.view.overlay = Some(OverlayState::CommandPalette {
            query: "/mo".to_owned(),
            selected: 1,
        });
        let reactions = accept_overlay(&state);
        assert!(matches!(
            reactions.as_slice(),
            [
                BusReaction::App(AppEvent::User(UserIntent::InputChanged(command))),
                BusReaction::App(AppEvent::User(UserIntent::CloseOverlay))
            ] if command == "/model"
        ));
    }
}
