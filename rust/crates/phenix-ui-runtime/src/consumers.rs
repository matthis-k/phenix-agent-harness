use crate::{
    BusReaction, ContentEvent, EventConsumer, EventRouter, Propagation, ReactionBatch, RouterError,
    UiEvent, ViewMutation,
};
use phenix_runtime_api::BackendOutput;
use phenix_ui_core::{
    AppEvent, AppState, ElementId, EventEnvelope, FocusTarget, InputEditor, KeyCode, MouseAction,
    MouseButton, UiInput, UserIntent, VimMode,
};

const MOUSE_SCROLL_LINES: i32 = 3;

struct RootContentConsumer {
    id: ElementId,
}

impl RootContentConsumer {
    fn new() -> Self {
        Self {
            id: ElementId::root(),
        }
    }
}

impl EventConsumer for RootContentConsumer {
    fn element_id(&self) -> &ElementId {
        &self.id
    }

    fn on_content(
        &mut self,
        state: &AppState,
        envelope: &EventEnvelope<ContentEvent>,
    ) -> ReactionBatch {
        match &envelope.event {
            ContentEvent::Backend(output) => match output.as_ref() {
                BackendOutput::Stopped { result } if !state.exit_requested => {
                    let message = match result {
                        Ok(()) => "runtime stopped unexpectedly".to_owned(),
                        Err(error) => format!("runtime stopped unexpectedly: {error}"),
                    };
                    ReactionBatch::one(BusReaction::App(AppEvent::BackendSubmitFailed(message)))
                }
                _ => ReactionBatch::one(BusReaction::App(AppEvent::Backend(output.clone()))),
            },
            ContentEvent::ClockTick | ContentEvent::RefreshRequested => {
                ReactionBatch::one(BusReaction::Render)
            }
        }
    }
}

struct UiStateConsumer {
    id: ElementId,
}

impl UiStateConsumer {
    fn new(id: ElementId) -> Self {
        Self { id }
    }

    fn pointer_mutation(&self, action: MouseAction) -> Option<ViewMutation> {
        match action {
            MouseAction::Press(MouseButton::Left) => {
                FocusTarget::from_element(&self.id).map(ViewMutation::SetFocus)
            }
            MouseAction::ScrollUp => match self.id.as_str() {
                // Transcript scroll is stored as distance from the end; sidebar
                // scroll is stored as distance from the start.
                "ui.transcript" => Some(ViewMutation::ScrollPane {
                    element: self.id.clone(),
                    lines: MOUSE_SCROLL_LINES,
                }),
                "ui.sidebar" => Some(ViewMutation::ScrollPane {
                    element: self.id.clone(),
                    lines: -MOUSE_SCROLL_LINES,
                }),
                _ => None,
            },
            MouseAction::ScrollDown => match self.id.as_str() {
                "ui.transcript" => Some(ViewMutation::ScrollPane {
                    element: self.id.clone(),
                    lines: -MOUSE_SCROLL_LINES,
                }),
                "ui.sidebar" => Some(ViewMutation::ScrollPane {
                    element: self.id.clone(),
                    lines: MOUSE_SCROLL_LINES,
                }),
                _ => None,
            },
            MouseAction::Press(MouseButton::Middle | MouseButton::Right)
            | MouseAction::Release(_)
            | MouseAction::Drag(_)
            | MouseAction::Move => None,
        }
    }

    fn consumes_input_normal_escape(&self, state: &AppState) -> bool {
        self.id == ElementId::input()
            && state.view.overlay.is_none()
            && state.view.focus == FocusTarget::Input
            && state.view.input_editor != InputEditor::External
            && state.view.vim_mode == VimMode::Normal
    }
}

impl EventConsumer for UiStateConsumer {
    fn element_id(&self) -> &ElementId {
        &self.id
    }

    fn on_ui(&mut self, state: &AppState, envelope: &EventEnvelope<UiEvent>) -> ReactionBatch {
        if matches!(
            &envelope.event,
            UiEvent::Input(UiInput::Key(key)) if key.code == KeyCode::Escape
        ) && self.consumes_input_normal_escape(state)
        {
            // Escape is a modal cancellation key. Runtime interruption remains
            // the explicit Ctrl-C / :abort action and must never happen merely
            // because a user is already in Normal mode.
            return ReactionBatch::stop(Vec::new());
        }

        let mutation = match &envelope.event {
            UiEvent::FocusRequested(element) => {
                FocusTarget::from_element(element).map(ViewMutation::SetFocus)
            }
            UiEvent::FocusMoveRequested(direction) => Some(ViewMutation::MoveFocus(*direction)),
            UiEvent::ResizeRequested {
                element,
                axis,
                request,
            } => Some(ViewMutation::ResizePane {
                element: element.clone(),
                axis: *axis,
                request: *request,
            }),
            UiEvent::VisibilityRequested { element, visible } => {
                Some(ViewMutation::SetPaneVisibility {
                    element: element.clone(),
                    visible: *visible,
                })
            }
            UiEvent::ScrollRequested { element, lines } => Some(ViewMutation::ScrollPane {
                element: element.clone(),
                lines: *lines,
            }),
            UiEvent::Input(UiInput::Mouse(mouse)) => self.pointer_mutation(mouse.action),
            UiEvent::Invalidate => return ReactionBatch::one(BusReaction::Render),
            UiEvent::Input(_) | UiEvent::ShutdownRequested => None,
        };
        mutation.map_or_else(ReactionBatch::none, |mutation| {
            ReactionBatch::stop(vec![BusReaction::View(mutation)])
        })
    }
}

/// Native interaction for rich transcript components. This deliberately remains
/// below the Lua keymap surface while the block interaction model is still being
/// stabilized. It does not define layout/window semantics.
struct TranscriptRichBlockConsumer {
    id: ElementId,
}

impl TranscriptRichBlockConsumer {
    fn new() -> Self {
        Self {
            id: ElementId::transcript(),
        }
    }
}

impl EventConsumer for TranscriptRichBlockConsumer {
    fn element_id(&self) -> &ElementId {
        &self.id
    }

    fn on_ui(&mut self, state: &AppState, envelope: &EventEnvelope<UiEvent>) -> ReactionBatch {
        if state.view.focus != FocusTarget::Transcript || state.view.overlay.is_some() {
            return ReactionBatch::none();
        }
        let UiEvent::Input(UiInput::Key(key)) = &envelope.event else {
            return ReactionBatch::none();
        };
        if key.modifiers.control || key.modifiers.alt {
            return ReactionBatch::none();
        }
        let initial = state.view.transcript_selected_block.is_none();
        let mutation = match key.code {
            KeyCode::Character('[') => {
                ViewMutation::MoveTranscriptBlock(if initial { 0 } else { -1 })
            }
            KeyCode::Character(']') => {
                ViewMutation::MoveTranscriptBlock(if initial { 0 } else { 1 })
            }
            KeyCode::Character('v') => ViewMutation::CycleTranscriptBlockView(1),
            KeyCode::Character('V') => ViewMutation::CycleTranscriptBlockView(-1),
            KeyCode::Character('H') => ViewMutation::ScrollTranscriptBlock {
                horizontal: -4,
                vertical: 0,
            },
            KeyCode::Character('L') => ViewMutation::ScrollTranscriptBlock {
                horizontal: 4,
                vertical: 0,
            },
            KeyCode::Character('J') => ViewMutation::ScrollTranscriptBlock {
                horizontal: 0,
                vertical: 1,
            },
            KeyCode::Character('K') => ViewMutation::ScrollTranscriptBlock {
                horizontal: 0,
                vertical: -1,
            },
            _ => return ReactionBatch::none(),
        };
        ReactionBatch::stop(vec![BusReaction::View(mutation)])
    }
}

#[derive(Clone, Copy)]
enum WorkspaceMode {
    Default,
    Advanced,
    Zen,
    Specialized,
}

struct WorkspaceModeConsumer {
    id: ElementId,
}

impl WorkspaceModeConsumer {
    fn new() -> Self {
        Self {
            id: ElementId::root(),
        }
    }
}

impl EventConsumer for WorkspaceModeConsumer {
    fn element_id(&self) -> &ElementId {
        &self.id
    }

    fn on_ui(&mut self, _state: &AppState, envelope: &EventEnvelope<UiEvent>) -> ReactionBatch {
        let UiEvent::Input(UiInput::Key(key)) = &envelope.event else {
            return ReactionBatch::none();
        };
        if !key.modifiers.alt || key.modifiers.control {
            return ReactionBatch::none();
        }
        let mode = match key.code {
            KeyCode::Character('1') => WorkspaceMode::Default,
            KeyCode::Character('2') => WorkspaceMode::Advanced,
            KeyCode::Character('3') => WorkspaceMode::Zen,
            KeyCode::Character('4') => WorkspaceMode::Specialized,
            _ => return ReactionBatch::none(),
        };
        ReactionBatch::stop(workspace_mode_reactions(mode))
    }
}

fn workspace_mode_reactions(mode: WorkspaceMode) -> Vec<BusReaction> {
    let (inspector, transcript, sidebar, specialized, input, status) = match mode {
        WorkspaceMode::Default => (false, true, true, false, true, true),
        WorkspaceMode::Advanced => (true, true, true, false, true, true),
        WorkspaceMode::Zen => (false, true, false, false, true, true),
        WorkspaceMode::Specialized => (false, false, false, true, false, false),
    };
    [
        (ElementId::header(), false),
        (ElementId::inspector(), inspector),
        (ElementId::transcript(), transcript),
        (ElementId::sidebar(), sidebar),
        (ElementId::specialized(), specialized),
        (ElementId::input(), input),
        (ElementId::status(), status),
    ]
    .into_iter()
    .map(|(element, visible)| {
        BusReaction::View(ViewMutation::SetPaneVisibility { element, visible })
    })
    .chain(std::iter::once(BusReaction::View(ViewMutation::SetFocus(
        FocusTarget::Transcript,
    ))))
    .collect()
}

struct ShutdownConsumer {
    id: ElementId,
}

impl ShutdownConsumer {
    fn new() -> Self {
        Self {
            id: ElementId::root(),
        }
    }
}

impl EventConsumer for ShutdownConsumer {
    fn element_id(&self) -> &ElementId {
        &self.id
    }

    fn on_ui(&mut self, _state: &AppState, envelope: &EventEnvelope<UiEvent>) -> ReactionBatch {
        if matches!(&envelope.event, UiEvent::ShutdownRequested) {
            ReactionBatch {
                reactions: vec![BusReaction::App(AppEvent::User(UserIntent::Quit))],
                propagation: Propagation::Stop,
            }
        } else {
            ReactionBatch::none()
        }
    }
}

pub fn install_core_consumers(router: &mut EventRouter) -> Result<(), RouterError> {
    router.register_consumer(Box::new(RootContentConsumer::new()))?;
    for element in [
        ElementId::root(),
        ElementId::layout(),
        ElementId::header(),
        ElementId::inspector(),
        ElementId::sidebar(),
        ElementId::transcript(),
        ElementId::specialized(),
        ElementId::input(),
        ElementId::status(),
    ] {
        router.register_consumer(Box::new(UiStateConsumer::new(element)))?;
    }
    router.register_consumer(Box::new(TranscriptRichBlockConsumer::new()))?;
    router.register_consumer(Box::new(WorkspaceModeConsumer::new()))?;
    router.register_consumer(Box::new(ShutdownConsumer::new()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::BackendError;
    use phenix_ui_core::{KeyInput, KeyModifiers, MouseInput};

    fn key(character: char) -> EventEnvelope<UiEvent> {
        EventEnvelope::to(
            ElementId::transcript(),
            UiEvent::Input(UiInput::Key(KeyInput {
                code: KeyCode::Character(character),
                modifiers: KeyModifiers::default(),
                repeat: false,
            })),
        )
    }

    fn escape(element: ElementId) -> EventEnvelope<UiEvent> {
        EventEnvelope::to(
            element,
            UiEvent::Input(UiInput::Key(KeyInput {
                code: KeyCode::Escape,
                modifiers: KeyModifiers::default(),
                repeat: false,
            })),
        )
    }

    fn mode_key(digit: char) -> EventEnvelope<UiEvent> {
        EventEnvelope::to(
            ElementId::root(),
            UiEvent::Input(UiInput::Key(KeyInput {
                code: KeyCode::Character(digit),
                modifiers: KeyModifiers {
                    alt: true,
                    ..KeyModifiers::default()
                },
                repeat: false,
            })),
        )
    }

    #[test]
    fn transcript_rich_block_controls_are_non_modal() {
        let mut state = AppState::default();
        state.view.focus = FocusTarget::Transcript;
        let mut consumer = TranscriptRichBlockConsumer::new();
        let batch = consumer.on_ui(&state, &key('v'));
        assert_eq!(batch.propagation, Propagation::Stop);
        assert_eq!(
            batch.reactions,
            vec![BusReaction::View(ViewMutation::CycleTranscriptBlockView(1))]
        );
        let first_move = consumer.on_ui(&state, &key(']'));
        assert_eq!(
            first_move.reactions,
            vec![BusReaction::View(ViewMutation::MoveTranscriptBlock(0))]
        );
        let ordinary = consumer.on_ui(&state, &key('x'));
        assert_eq!(ordinary.propagation, Propagation::Continue);
        assert!(ordinary.reactions.is_empty());
    }

    #[test]
    fn escape_is_non_destructive_in_input_normal_mode() {
        let mut state = AppState::default();
        state.view.focus = FocusTarget::Input;
        state.view.vim_mode = VimMode::Normal;
        let mut input = UiStateConsumer::new(ElementId::input());
        let batch = input.on_ui(&state, &escape(ElementId::input()));
        assert_eq!(batch.propagation, Propagation::Stop);
        assert!(batch.reactions.is_empty());
    }

    #[test]
    fn insert_and_external_escape_still_reach_editor_fallback() {
        let mut state = AppState::default();
        state.view.focus = FocusTarget::Input;
        let mut input = UiStateConsumer::new(ElementId::input());

        state.view.vim_mode = VimMode::Insert;
        let insert = input.on_ui(&state, &escape(ElementId::input()));
        assert_eq!(insert.propagation, Propagation::Continue);

        state.view.vim_mode = VimMode::Normal;
        state.view.input_editor = InputEditor::External;
        let external = input.on_ui(&state, &escape(ElementId::input()));
        assert_eq!(external.propagation, Propagation::Continue);
    }

    #[test]
    fn transcript_pointer_scroll_does_not_require_transcript_focus() {
        let mut state = AppState::default();
        state.view.focus = FocusTarget::Input;
        let mut consumer = UiStateConsumer::new(ElementId::transcript());
        let envelope = EventEnvelope::to(
            ElementId::transcript(),
            UiEvent::Input(UiInput::Mouse(MouseInput {
                column: 4,
                row: 5,
                action: MouseAction::ScrollDown,
                modifiers: KeyModifiers::default(),
            })),
        );
        let batch = consumer.on_ui(&state, &envelope);
        assert_eq!(
            batch.reactions,
            vec![BusReaction::View(ViewMutation::ScrollPane {
                element: ElementId::transcript(),
                lines: -MOUSE_SCROLL_LINES,
            })]
        );
        assert_eq!(state.view.focus, FocusTarget::Input);
    }

    #[test]
    fn zen_mode_hides_auxiliary_workspace_panes() {
        let mut consumer = WorkspaceModeConsumer::new();
        let batch = consumer.on_ui(&AppState::default(), &mode_key('3'));
        assert_eq!(batch.propagation, Propagation::Stop);
        assert!(batch.reactions.iter().any(|reaction| matches!(
            reaction,
            BusReaction::View(ViewMutation::SetPaneVisibility { element, visible: false })
                if element == &ElementId::sidebar()
        )));
        assert!(batch.reactions.iter().any(|reaction| matches!(
            reaction,
            BusReaction::View(ViewMutation::SetPaneVisibility { element, visible: true })
                if element == &ElementId::transcript()
        )));
    }

    #[test]
    fn unexpected_backend_stop_is_a_visible_failure_not_a_user_quit() {
        let mut consumer = RootContentConsumer::new();
        let state = AppState::default();
        let envelope =
            EventEnvelope::broadcast(ContentEvent::Backend(Box::new(BackendOutput::Stopped {
                result: Err(BackendError::Transport("downstream closed".to_owned())),
            })));
        let batch = consumer.on_content(&state, &envelope);
        assert!(matches!(
            batch.reactions.as_slice(),
            [BusReaction::App(AppEvent::BackendSubmitFailed(message))]
                if message.contains("downstream closed")
        ));
    }

    #[test]
    fn requested_backend_stop_still_completes_shutdown() {
        let mut consumer = RootContentConsumer::new();
        let mut state = AppState::default();
        state.exit_requested = true;
        let output = Box::new(BackendOutput::Stopped { result: Ok(()) });
        let envelope = EventEnvelope::broadcast(ContentEvent::Backend(output.clone()));
        let batch = consumer.on_content(&state, &envelope);
        assert_eq!(
            batch.reactions,
            vec![BusReaction::App(AppEvent::Backend(output))]
        );
    }
}
