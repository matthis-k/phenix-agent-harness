use phenix_runtime_api::BackendOutput;
use phenix_ui_core::{
    AppEvent, AppState, ElementId, EventEnvelope, FocusTarget, RouteTarget, UiInput,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContentEvent {
    Backend(BackendOutput),
    ClockTick,
    RefreshRequested,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LayoutAxis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResizeRequest {
    Grow(u16),
    Shrink(u16),
    Set(u16),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UiEvent {
    Input(UiInput),
    FocusRequested(ElementId),
    ResizeRequested {
        element: ElementId,
        axis: LayoutAxis,
        request: ResizeRequest,
    },
    VisibilityRequested {
        element: ElementId,
        visible: bool,
    },
    ScrollRequested {
        element: ElementId,
        lines: i32,
    },
    Invalidate,
    ShutdownRequested,
}

#[derive(Debug, Eq, PartialEq)]
pub enum BusReaction {
    App(AppEvent),
    Content(EventEnvelope<ContentEvent>),
    Ui(EventEnvelope<UiEvent>),
    Render,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Propagation {
    #[default]
    Continue,
    Stop,
}

#[derive(Debug, Default, Eq, PartialEq)]
pub struct ReactionBatch {
    pub reactions: Vec<BusReaction>,
    pub propagation: Propagation,
}

impl ReactionBatch {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn one(reaction: BusReaction) -> Self {
        Self {
            reactions: vec![reaction],
            propagation: Propagation::Continue,
        }
    }

    pub fn stop(reactions: Vec<BusReaction>) -> Self {
        Self {
            reactions,
            propagation: Propagation::Stop,
        }
    }
}

pub trait EventConsumer: Send {
    fn element_id(&self) -> &ElementId;

    fn on_content(
        &mut self,
        _state: &AppState,
        _envelope: &EventEnvelope<ContentEvent>,
    ) -> ReactionBatch {
        ReactionBatch::none()
    }

    fn on_ui(
        &mut self,
        _state: &AppState,
        _envelope: &EventEnvelope<UiEvent>,
    ) -> ReactionBatch {
        ReactionBatch::none()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ElementNode {
    parent: Option<ElementId>,
}

pub struct EventRouter {
    nodes: BTreeMap<ElementId, ElementNode>,
    order: Vec<ElementId>,
    consumers: BTreeMap<ElementId, Box<dyn EventConsumer>>,
}

impl EventRouter {
    pub fn standard() -> Self {
        let mut router = Self::default();
        router
            .register_element(ElementId::root(), None)
            .expect("root element registration is valid");
        router
            .register_element(ElementId::layout(), Some(ElementId::root()))
            .expect("layout element registration is valid");
        for element in [
            ElementId::sidebar(),
            ElementId::transcript(),
            ElementId::input(),
            ElementId::status(),
        ] {
            router
                .register_element(element, Some(ElementId::layout()))
                .expect("standard pane registration is valid");
        }
        router
            .register_element(ElementId::overlay(), Some(ElementId::root()))
            .expect("overlay element registration is valid");
        router
    }

    pub fn register_element(
        &mut self,
        element: ElementId,
        parent: Option<ElementId>,
    ) -> Result<(), RouterError> {
        if self.nodes.contains_key(&element) {
            return Err(RouterError::DuplicateElement(element));
        }
        if let Some(parent) = &parent {
            if !self.nodes.contains_key(parent) {
                return Err(RouterError::MissingParent(parent.clone()));
            }
        }
        self.order.push(element.clone());
        self.nodes.insert(element, ElementNode { parent });
        Ok(())
    }

    pub fn register_consumer(
        &mut self,
        consumer: Box<dyn EventConsumer>,
    ) -> Result<(), RouterError> {
        let element = consumer.element_id().clone();
        if !self.nodes.contains_key(&element) {
            return Err(RouterError::UnknownElement(element));
        }
        if self.consumers.insert(element.clone(), consumer).is_some() {
            return Err(RouterError::DuplicateConsumer(element));
        }
        Ok(())
    }

    pub fn route_content(
        &mut self,
        state: &AppState,
        envelope: &EventEnvelope<ContentEvent>,
    ) -> Vec<BusReaction> {
        let route = self.resolve(state, &envelope.target);
        self.dispatch(route, |consumer| consumer.on_content(state, envelope))
    }

    pub fn route_ui(
        &mut self,
        state: &AppState,
        envelope: &EventEnvelope<UiEvent>,
    ) -> Vec<BusReaction> {
        let route = self.resolve(state, &envelope.target);
        self.dispatch(route, |consumer| consumer.on_ui(state, envelope))
    }

    fn dispatch(
        &mut self,
        route: Vec<ElementId>,
        mut react: impl FnMut(&mut dyn EventConsumer) -> ReactionBatch,
    ) -> Vec<BusReaction> {
        let mut reactions = Vec::new();
        for element in route {
            let Some(consumer) = self.consumers.get_mut(&element) else {
                continue;
            };
            let batch = react(consumer.as_mut());
            reactions.extend(batch.reactions);
            if batch.propagation == Propagation::Stop {
                break;
            }
        }
        reactions
    }

    fn resolve(&self, state: &AppState, target: &RouteTarget) -> Vec<ElementId> {
        match target {
            RouteTarget::Broadcast => self.order.clone(),
            RouteTarget::Focused => self.bubble_path(&focused_element(state)),
            RouteTarget::Element(element) => self
                .nodes
                .contains_key(element)
                .then(|| vec![element.clone()])
                .unwrap_or_default(),
            RouteTarget::Subtree(root) => self
                .order
                .iter()
                .filter(|candidate| self.is_descendant_or_self(candidate, root))
                .cloned()
                .collect(),
            RouteTarget::Bubble(element) => self.bubble_path(element),
        }
    }

    fn bubble_path(&self, element: &ElementId) -> Vec<ElementId> {
        let mut path = Vec::new();
        let mut current = Some(element.clone());
        while let Some(element) = current {
            let Some(node) = self.nodes.get(&element) else {
                break;
            };
            path.push(element);
            current = node.parent.clone();
        }
        path
    }

    fn is_descendant_or_self(&self, candidate: &ElementId, root: &ElementId) -> bool {
        let mut current = Some(candidate.clone());
        while let Some(element) = current {
            if &element == root {
                return true;
            }
            current = self.nodes.get(&element).and_then(|node| node.parent.clone());
        }
        false
    }
}

impl Default for EventRouter {
    fn default() -> Self {
        Self {
            nodes: BTreeMap::new(),
            order: Vec::new(),
            consumers: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouterError {
    DuplicateElement(ElementId),
    MissingParent(ElementId),
    UnknownElement(ElementId),
    DuplicateConsumer(ElementId),
}

impl Display for RouterError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateElement(element) => write!(formatter, "duplicate UI element: {element}"),
            Self::MissingParent(element) => write!(formatter, "missing UI parent: {element}"),
            Self::UnknownElement(element) => write!(formatter, "unknown UI element: {element}"),
            Self::DuplicateConsumer(element) => {
                write!(formatter, "duplicate UI consumer: {element}")
            }
        }
    }
}

impl Error for RouterError {}

fn focused_element(state: &AppState) -> ElementId {
    match state.view.focus {
        FocusTarget::Sidebar => ElementId::sidebar(),
        FocusTarget::Transcript => ElementId::transcript(),
        FocusTarget::Input => ElementId::input(),
        FocusTarget::Overlay => ElementId::overlay(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_ui_core::{KeyCode, KeyInput, KeyModifiers};
    use std::sync::{Arc, Mutex};

    struct RecordingConsumer {
        id: ElementId,
        calls: Arc<Mutex<Vec<ElementId>>>,
        stop: bool,
        reaction: Option<fn() -> BusReaction>,
    }

    impl EventConsumer for RecordingConsumer {
        fn element_id(&self) -> &ElementId {
            &self.id
        }

        fn on_ui(
            &mut self,
            _state: &AppState,
            _envelope: &EventEnvelope<UiEvent>,
        ) -> ReactionBatch {
            self.calls.lock().expect("calls lock").push(self.id.clone());
            let reactions = self.reaction.map_or_else(Vec::new, |reaction| vec![reaction()]);
            if self.stop {
                ReactionBatch::stop(reactions)
            } else {
                ReactionBatch {
                    reactions,
                    propagation: Propagation::Continue,
                }
            }
        }
    }

    #[test]
    fn explicit_routes_only_reach_the_addressed_element() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut router = router_with_recorders(Arc::clone(&calls));
        let envelope = EventEnvelope::to(
            ElementId::sidebar(),
            UiEvent::VisibilityRequested {
                element: ElementId::sidebar(),
                visible: true,
            },
        );
        router.route_ui(&AppState::default(), &envelope);
        assert_eq!(
            *calls.lock().expect("calls lock"),
            vec![ElementId::sidebar()]
        );
    }

    #[test]
    fn focused_routes_bubble_from_the_focused_pane_to_its_ancestors() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut router = router_with_recorders(Arc::clone(&calls));
        let envelope = EventEnvelope::focused(UiEvent::Input(UiInput::Key(KeyInput {
            code: KeyCode::Character('x'),
            modifiers: KeyModifiers::default(),
            repeat: false,
        })));
        router.route_ui(&AppState::default(), &envelope);
        assert_eq!(
            *calls.lock().expect("calls lock"),
            vec![ElementId::input(), ElementId::layout(), ElementId::root()]
        );
    }

    #[test]
    fn consumers_can_stop_bubbling_after_handling_an_event() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut router = EventRouter::standard();
        router
            .register_consumer(Box::new(RecordingConsumer {
                id: ElementId::input(),
                calls: Arc::clone(&calls),
                stop: true,
                reaction: None,
            }))
            .expect("input consumer");
        router
            .register_consumer(Box::new(RecordingConsumer {
                id: ElementId::root(),
                calls: Arc::clone(&calls),
                stop: false,
                reaction: None,
            }))
            .expect("root consumer");
        router.route_ui(
            &AppState::default(),
            &EventEnvelope::focused(UiEvent::Invalidate),
        );
        assert_eq!(
            *calls.lock().expect("calls lock"),
            vec![ElementId::input()]
        );
    }

    #[test]
    fn a_pane_can_emit_a_routed_ui_request_for_the_layout_consumer() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut router = EventRouter::standard();
        router
            .register_consumer(Box::new(RecordingConsumer {
                id: ElementId::sidebar(),
                calls: Arc::clone(&calls),
                stop: false,
                reaction: Some(|| {
                    BusReaction::Ui(
                        EventEnvelope::to(
                            ElementId::layout(),
                            UiEvent::ResizeRequested {
                                element: ElementId::sidebar(),
                                axis: LayoutAxis::Horizontal,
                                request: ResizeRequest::Grow(4),
                            },
                        )
                        .from(ElementId::sidebar()),
                    )
                }),
            }))
            .expect("sidebar consumer");
        let reactions = router.route_ui(
            &AppState::default(),
            &EventEnvelope::to(ElementId::sidebar(), UiEvent::Invalidate),
        );
        assert!(matches!(
            reactions.as_slice(),
            [BusReaction::Ui(EventEnvelope {
                source: Some(source),
                target: RouteTarget::Element(target),
                event: UiEvent::ResizeRequested { element, .. },
            })] if source == &ElementId::sidebar()
                && target == &ElementId::layout()
                && element == &ElementId::sidebar()
        ));
    }

    fn router_with_recorders(calls: Arc<Mutex<Vec<ElementId>>>) -> EventRouter {
        let mut router = EventRouter::standard();
        for id in [
            ElementId::root(),
            ElementId::layout(),
            ElementId::sidebar(),
            ElementId::input(),
        ] {
            router
                .register_consumer(Box::new(RecordingConsumer {
                    id,
                    calls: Arc::clone(&calls),
                    stop: false,
                    reaction: None,
                }))
                .expect("consumer registration");
        }
        router
    }
}
