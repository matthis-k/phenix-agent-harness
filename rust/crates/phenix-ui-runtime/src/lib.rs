#![forbid(unsafe_code)]

mod fabric;

pub use fabric::{
    BusReaction, ContentEvent, EventConsumer, EventRouter, InputEdit, Propagation, ReactionBatch,
    RouterError, UiEvent, ViewMutation,
};

use phenix_runtime_api::{BackendClient, BackendOutput, BackendRuntime, BackendWorker};
use phenix_ui_core::{
    reduce, AppEffect, AppEvent, AppState, ElementId, EventEnvelope, FocusDirection, FocusTarget,
    LayoutAxis, OverlayState, ResizeRequest, UiInput, UserIntent,
};
use std::collections::VecDeque;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const DEFAULT_DRAIN_LIMIT: usize = 256;

#[derive(Debug, Eq, PartialEq)]
pub enum UiMessage {
    Content(EventEnvelope<ContentEvent>),
    Ui(EventEnvelope<UiEvent>),
    App(AppEvent),
}

#[derive(Clone)]
pub struct UiMailbox {
    sender: SyncSender<UiMessage>,
}

impl UiMailbox {
    pub fn send_input(&self, input: UiInput) -> Result<(), UiIngressError> {
        self.send_ui(EventEnvelope::focused(UiEvent::Input(input)))
    }

    pub fn send_ui(&self, event: EventEnvelope<UiEvent>) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::Ui(event))
    }

    pub fn send_content(&self, event: EventEnvelope<ContentEvent>) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::Content(event))
    }

    pub fn send_user(&self, intent: UserIntent) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::App(AppEvent::User(intent)))
    }

    pub fn send_backend(&self, output: BackendOutput) -> Result<(), UiIngressError> {
        self.send_content(EventEnvelope::broadcast(ContentEvent::Backend(output)))
    }

    pub fn request_refresh(&self) -> Result<(), UiIngressError> {
        self.try_send_coalescible(UiMessage::Content(EventEnvelope::broadcast(
            ContentEvent::RefreshRequested,
        )))
    }

    pub fn tick(&self) -> Result<(), UiIngressError> {
        self.try_send_coalescible(UiMessage::Content(EventEnvelope::broadcast(
            ContentEvent::ClockTick,
        )))
    }

    pub fn shutdown(&self) -> Result<(), UiIngressError> {
        self.send_ui(EventEnvelope::to(
            ElementId::root(),
            UiEvent::ShutdownRequested,
        ))
    }

    fn send_lossless(&self, message: UiMessage) -> Result<(), UiIngressError> {
        self.sender
            .send(message)
            .map_err(|_| UiIngressError::Disconnected)
    }

    fn try_send_coalescible(&self, message: UiMessage) -> Result<(), UiIngressError> {
        match self.sender.try_send(message) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(UiIngressError::Coalesced),
            Err(TrySendError::Disconnected(_)) => Err(UiIngressError::Disconnected),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UiIngressError {
    Coalesced,
    Disconnected,
}

impl Display for UiIngressError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Coalesced => formatter.write_str("coalescible UI message was dropped"),
            Self::Disconnected => formatter.write_str("UI mailbox is disconnected"),
        }
    }
}

impl Error for UiIngressError {}

pub trait UiRenderer {
    fn render(&mut self, state: &AppState) -> Result<(), String>;
}

pub trait UiInputController {
    fn handle(&mut self, state: &AppState, input: UiInput) -> Vec<AppEvent>;
}

#[derive(Default)]
pub struct NoopInputController;

impl UiInputController for NoopInputController {
    fn handle(&mut self, _state: &AppState, _input: UiInput) -> Vec<AppEvent> {
        Vec::new()
    }
}

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

    fn on_ui(
        &mut self,
        _state: &AppState,
        envelope: &EventEnvelope<UiEvent>,
    ) -> ReactionBatch {
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
            UiEvent::Invalidate => return ReactionBatch::one(BusReaction::Render),
            UiEvent::Input(_) | UiEvent::ShutdownRequested => None,
        };
        mutation.map_or_else(ReactionBatch::none, |mutation| {
            ReactionBatch::stop(vec![BusReaction::View(mutation)])
        })
    }
}

struct RootInputConsumer<C> {
    id: ElementId,
    controller: C,
}

impl<C> RootInputConsumer<C> {
    fn new(controller: C) -> Self {
        Self {
            id: ElementId::root(),
            controller,
        }
    }
}

impl<C: UiInputController> EventConsumer for RootInputConsumer<C> {
    fn element_id(&self) -> &ElementId {
        &self.id
    }

    fn on_ui(
        &mut self,
        state: &AppState,
        envelope: &EventEnvelope<UiEvent>,
    ) -> ReactionBatch {
        match &envelope.event {
            UiEvent::Input(input) => ReactionBatch {
                reactions: self
                    .controller
                    .handle(state, input.clone())
                    .into_iter()
                    .map(BusReaction::App)
                    .collect(),
                propagation: Propagation::Continue,
            },
            UiEvent::ShutdownRequested => ReactionBatch::stop(vec![BusReaction::App(
                AppEvent::User(UserIntent::Quit),
            )]),
            UiEvent::FocusRequested(_)
            | UiEvent::FocusMoveRequested(_)
            | UiEvent::ResizeRequested { .. }
            | UiEvent::VisibilityRequested { .. }
            | UiEvent::ScrollRequested { .. }
            | UiEvent::Invalidate => ReactionBatch::none(),
        }
    }
}

pub fn install_core_consumers(router: &mut EventRouter) -> Result<(), RouterError> {
    router.register_consumer(Box::new(RootContentConsumer::new()))?;
    router.register_consumer(Box::new(UiStateConsumer::new(ElementId::root())))?;
    router.register_consumer(Box::new(UiStateConsumer::new(ElementId::layout())))?;
    Ok(())
}

pub fn install_input_controller<C: UiInputController + 'static>(
    router: &mut EventRouter,
    controller: C,
) -> Result<(), RouterError> {
    router.register_consumer(Box::new(RootInputConsumer::new(controller)))
}

pub struct UiRuntime<R> {
    state: AppState,
    backend: BackendClient,
    renderer: R,
    router: EventRouter,
    receiver: Receiver<UiMessage>,
    mailbox: UiMailbox,
    backend_forwarder: Option<JoinHandle<()>>,
    backend_worker: Option<BackendWorker>,
    drain_limit: usize,
}

impl<R> UiRuntime<R> {
    fn detach_workers(&mut self) {
        let _ = self.backend_forwarder.take();
        let _ = self.backend_worker.take();
    }
}

impl<R: UiRenderer> UiRuntime<R> {
    pub fn from_backend(
        state: AppState,
        backend: BackendRuntime,
        renderer: R,
        channel_capacity: usize,
    ) -> Result<Self, UiRuntimeError> {
        Self::from_backend_with_controller(
            state,
            backend,
            renderer,
            NoopInputController,
            channel_capacity,
        )
    }

    pub fn from_backend_with_controller<C: UiInputController + 'static>(
        state: AppState,
        backend: BackendRuntime,
        renderer: R,
        input_controller: C,
        channel_capacity: usize,
    ) -> Result<Self, UiRuntimeError> {
        let mut router = EventRouter::standard();
        install_core_consumers(&mut router)
            .map_err(|error| UiRuntimeError::InvalidConfiguration(error.to_string()))?;
        install_input_controller(&mut router, input_controller)
            .map_err(|error| UiRuntimeError::InvalidConfiguration(error.to_string()))?;
        Self::from_backend_with_router(state, backend, renderer, router, channel_capacity)
    }

    pub fn from_backend_with_router(
        state: AppState,
        backend: BackendRuntime,
        renderer: R,
        router: EventRouter,
        channel_capacity: usize,
    ) -> Result<Self, UiRuntimeError> {
        if channel_capacity == 0 {
            return Err(UiRuntimeError::InvalidConfiguration(
                "UI channel capacity must be positive".to_owned(),
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(channel_capacity);
        let mailbox = UiMailbox { sender };
        let (backend, outputs, backend_worker) = backend.split();
        let backend_mailbox = mailbox.clone();
        let backend_forwarder = thread::Builder::new()
            .name("phenix-ui-backend-forwarder".to_owned())
            .spawn(move || {
                for output in outputs {
                    if backend_mailbox.send_backend(output).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| UiRuntimeError::Start(error.to_string()))?;

        Ok(Self {
            state,
            backend,
            renderer,
            router,
            receiver,
            mailbox,
            backend_forwarder: Some(backend_forwarder),
            backend_worker: Some(backend_worker),
            drain_limit: DEFAULT_DRAIN_LIMIT,
        })
    }

    pub fn mailbox(&self) -> UiMailbox {
        self.mailbox.clone()
    }

    pub fn spawn_ticker(&self, period: Duration) -> Result<JoinHandle<()>, UiRuntimeError> {
        if period.is_zero() {
            return Err(UiRuntimeError::InvalidConfiguration(
                "UI tick period must be positive".to_owned(),
            ));
        }
        let mailbox = self.mailbox();
        thread::Builder::new()
            .name("phenix-ui-ticker".to_owned())
            .spawn(move || loop {
                thread::sleep(period);
                match mailbox.tick() {
                    Ok(()) | Err(UiIngressError::Coalesced) => {}
                    Err(UiIngressError::Disconnected) => break,
                }
            })
            .map_err(|error| UiRuntimeError::Start(error.to_string()))
    }

    pub fn run(mut self) -> Result<AppState, UiRuntimeError> {
        let mut dirty = true;
        while !self.state.should_quit {
            if dirty {
                self.renderer
                    .render(&self.state)
                    .map_err(UiRuntimeError::Render)?;
                dirty = false;
            }
            let message = self
                .receiver
                .recv()
                .map_err(|_| UiRuntimeError::Disconnected)?;
            dirty |= self.apply(message);
            for _ in 1..DEFAULT_DRAIN_LIMIT {
                match self.receiver.try_recv() {
                    Ok(message) => dirty |= self.apply(message),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => break,
                }
                if self.state.should_quit {
                    break;
                }
            }
        }
        if dirty {
            self.renderer
                .render(&self.state)
                .map_err(UiRuntimeError::Render)?;
        }
        self.detach_workers();
        Ok(self.state)
    }

    fn apply(&mut self, message: UiMessage) -> bool {
        let reactions = match message {
            UiMessage::Content(envelope) => self.router.route_content(&self.state, &envelope),
            UiMessage::Ui(envelope) => self.router.route_ui(&self.state, &envelope),
            UiMessage::App(event) => vec![BusReaction::App(event)],
        };
        self.apply_reactions(reactions)
    }

    fn apply_reactions(&mut self, reactions: impl IntoIterator<Item = BusReaction>) -> bool {
        let mut queue = VecDeque::from_iter(reactions);
        let mut dirty = false;
        while let Some(reaction) = queue.pop_front() {
            match reaction {
                BusReaction::App(event) => dirty |= self.apply_event(event),
                BusReaction::Content(envelope) => {
                    queue.extend(self.router.route_content(&self.state, &envelope))
                }
                BusReaction::Ui(envelope) => {
                    queue.extend(self.router.route_ui(&self.state, &envelope))
                }
                BusReaction::View(mutation) => {
                    apply_view_mutation(&mut self.state, mutation);
                    dirty = true;
                }
                BusReaction::Render => dirty = true,
            }
        }
        dirty
    }

    fn apply_event(&mut self, event: AppEvent) -> bool {
        let mut effects = VecDeque::from(reduce(&mut self.state, event));
        let mut dirty = false;
        while let Some(effect) = effects.pop_front() {
            match effect {
                AppEffect::Send(command) => {
                    if let Err(error) = self.backend.submit(command) {
                        effects.extend(reduce(
                            &mut self.state,
                            AppEvent::BackendSubmitFailed(error.to_string()),
                        ));
                    }
                }
                AppEffect::Render => dirty = true,
                AppEffect::Quit => self.state.should_quit = true,
            }
        }
        dirty
    }
}

impl<R> Drop for UiRuntime<R> {
    fn drop(&mut self) {
        self.detach_workers();
    }
}

fn apply_view_mutation(state: &mut AppState, mutation: ViewMutation) {
    match mutation {
        ViewMutation::SetFocus(focus) => state.view.focus = focus,
        ViewMutation::MoveFocus(direction) => {
            state.view.focus = move_focus(state.view.focus, direction);
        }
        ViewMutation::ResizePane {
            element,
            axis,
            request,
        } => {
            let pane = state.view.pane_mut(element);
            let dimension = match axis {
                LayoutAxis::Horizontal => &mut pane.width,
                LayoutAxis::Vertical => &mut pane.height,
            };
            let current = dimension.unwrap_or(1);
            *dimension = Some(match request {
                ResizeRequest::Grow(amount) => current.saturating_add(amount).max(1),
                ResizeRequest::Shrink(amount) => current.saturating_sub(amount).max(1),
                ResizeRequest::Set(value) => value.max(1),
            });
        }
        ViewMutation::SetPaneVisibility { element, visible } => {
            state.view.pane_mut(element.clone()).visible = visible;
            if !visible && FocusTarget::from_element(&element) == Some(state.view.focus) {
                state.view.focus = FocusTarget::Input;
            }
        }
        ViewMutation::ScrollPane { element, lines } => {
            let scroll = match element.as_str() {
                "ui.sidebar" => Some(&mut state.view.sidebar_scroll),
                "ui.transcript" => Some(&mut state.view.transcript_scroll),
                _ => None,
            };
            if let Some(scroll) = scroll {
                scroll.follow_end = false;
                scroll.offset = scroll.offset.saturating_add_signed(lines as isize);
            }
        }
        ViewMutation::EditInput(edit) => apply_input_edit(state, edit),
        ViewMutation::MoveOverlaySelection(delta) => move_overlay_selection(state, delta),
    }
}

fn apply_input_edit(state: &mut AppState, edit: InputEdit) {
    match edit {
        InputEdit::Insert(text) => state.input.insert(&text),
        InputEdit::Backspace => state.input.backspace(),
        InputEdit::Delete => state.input.delete(),
        InputEdit::MoveLeft => state.input.move_left(),
        InputEdit::MoveRight => state.input.move_right(),
        InputEdit::HistoryPrevious => {
            if state.input.history.is_empty() {
                return;
            }
            let offset = state
                .input
                .history_cursor
                .map_or(0, |offset| (offset + 1).min(state.input.history.len() - 1));
            state.input.history_cursor = Some(offset);
            let index = state.input.history.len() - 1 - offset;
            state.input.text = state.input.history[index].clone();
            state.input.cursor_byte = state.input.text.len();
        }
        InputEdit::HistoryNext => {
            let Some(offset) = state.input.history_cursor else {
                return;
            };
            if offset == 0 {
                state.input.history_cursor = None;
                state.input.text.clear();
                state.input.cursor_byte = 0;
            } else {
                let next = offset - 1;
                state.input.history_cursor = Some(next);
                let index = state.input.history.len() - 1 - next;
                state.input.text = state.input.history[index].clone();
                state.input.cursor_byte = state.input.text.len();
            }
        }
    }
}

fn move_overlay_selection(state: &mut AppState, delta: i32) {
    let length = match &state.view.overlay {
        Some(OverlayState::CommandPalette { .. }) => state.commands.len(),
        Some(OverlayState::ModelPicker { .. }) => state.models.len(),
        Some(OverlayState::AuthenticationProviders { .. }) => state.auth_providers.len(),
        Some(OverlayState::AuthenticationPrompt { prompt, .. }) => match prompt {
            phenix_runtime_api::AuthPrompt::Select { options, .. } => options.len(),
            _ => 0,
        },
        Some(OverlayState::SessionPicker { .. }) => state
            .snapshot
            .as_ref()
            .map_or(0, |snapshot| snapshot.sessions.len()),
        Some(OverlayState::ExtensionDialog { request, .. }) => match request {
            phenix_runtime_api::ExtensionUiRequest::Select { options, .. } => options.len(),
            _ => 0,
        },
        Some(OverlayState::Help) | None => 0,
    };
    if length == 0 {
        return;
    }
    let selected = match state.view.overlay.as_mut() {
        Some(OverlayState::CommandPalette { selected, .. })
        | Some(OverlayState::ModelPicker { selected, .. })
        | Some(OverlayState::AuthenticationProviders { selected, .. })
        | Some(OverlayState::AuthenticationPrompt { selected, .. })
        | Some(OverlayState::SessionPicker { selected, .. })
        | Some(OverlayState::ExtensionDialog { selected, .. }) => selected,
        Some(OverlayState::Help) | None => return,
    };
    *selected = selected
        .saturating_add_signed(delta as isize)
        .min(length.saturating_sub(1));
}

fn move_focus(current: FocusTarget, direction: FocusDirection) -> FocusTarget {
    match direction {
        FocusDirection::Next => match current {
            FocusTarget::Sidebar => FocusTarget::Transcript,
            FocusTarget::Transcript => FocusTarget::Input,
            FocusTarget::Input | FocusTarget::Overlay => FocusTarget::Sidebar,
        },
        FocusDirection::Previous => match current {
            FocusTarget::Sidebar => FocusTarget::Input,
            FocusTarget::Transcript => FocusTarget::Sidebar,
            FocusTarget::Input | FocusTarget::Overlay => FocusTarget::Transcript,
        },
        FocusDirection::Left => FocusTarget::Transcript,
        FocusDirection::Right => FocusTarget::Sidebar,
        FocusDirection::Up => FocusTarget::Transcript,
        FocusDirection::Down => FocusTarget::Input,
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum UiRuntimeError {
    InvalidConfiguration(String),
    Start(String),
    Render(String),
    Disconnected,
}

impl Display for UiRuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration(message) => {
                write!(formatter, "invalid UI runtime configuration: {message}")
            }
            Self::Start(message) => write!(formatter, "failed to start UI producer: {message}"),
            Self::Render(message) => write!(formatter, "failed to render UI: {message}"),
            Self::Disconnected => formatter.write_str("all UI message producers disconnected"),
        }
    }
}

impl Error for UiRuntimeError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_mutations_preserve_editor_cursor_and_pane_size() {
        let mut state = AppState::default();
        apply_view_mutation(
            &mut state,
            ViewMutation::EditInput(InputEdit::Insert("abc".to_owned())),
        );
        apply_view_mutation(
            &mut state,
            ViewMutation::EditInput(InputEdit::MoveLeft),
        );
        apply_view_mutation(
            &mut state,
            ViewMutation::EditInput(InputEdit::Insert("x".to_owned())),
        );
        assert_eq!(state.input.text, "abxc");

        apply_view_mutation(
            &mut state,
            ViewMutation::ResizePane {
                element: ElementId::sidebar(),
                axis: LayoutAxis::Horizontal,
                request: ResizeRequest::Grow(4),
            },
        );
        assert_eq!(state.view.pane(&ElementId::sidebar()).width, Some(32));
    }
}
