use crate::{
    BusReaction, ContentEvent, EventConsumer, EventRouter, Propagation, ReactionBatch, RouterError,
    UiEvent, ViewMutation,
};
use phenix_ui_core::{AppEvent, AppState, ElementId, EventEnvelope, FocusTarget, UserIntent};

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
        _state: &AppState,
        envelope: &EventEnvelope<ContentEvent>,
    ) -> ReactionBatch {
        match &envelope.event {
            ContentEvent::Backend(output) => {
                ReactionBatch::one(BusReaction::App(AppEvent::Backend(output.clone())))
            }
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
}

impl EventConsumer for UiStateConsumer {
    fn element_id(&self) -> &ElementId {
        &self.id
    }

    fn on_ui(&mut self, _state: &AppState, envelope: &EventEnvelope<UiEvent>) -> ReactionBatch {
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
            UiEvent::Input(phenix_ui_core::UiInput::Resize { width, height }) => {
                Some(ViewMutation::SetTerminalSize {
                    width: *width,
                    height: *height,
                })
            }
            UiEvent::Invalidate => return ReactionBatch::one(BusReaction::Render),
            UiEvent::Input(_) | UiEvent::ShutdownRequested => None,
        };
        mutation.map_or_else(ReactionBatch::none, |mutation| {
            ReactionBatch::stop(vec![BusReaction::View(mutation)])
        })
    }
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
        ElementId::sidebar(),
        ElementId::transcript(),
        ElementId::input(),
        ElementId::status(),
    ] {
        router.register_consumer(Box::new(UiStateConsumer::new(element)))?;
    }
    router.register_consumer(Box::new(ShutdownConsumer::new()))?;
    Ok(())
}
