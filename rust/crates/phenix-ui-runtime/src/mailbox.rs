use crate::{ContentEvent, UiEvent};
use phenix_runtime_api::BackendOutput;
use phenix_ui_core::{AppEvent, ElementId, EventEnvelope, UiInput, UserIntent};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::mpsc::{SyncSender, TrySendError};

#[derive(Debug, Eq, PartialEq)]
pub enum UiMessage {
    Content(Box<EventEnvelope<ContentEvent>>),
    Ui(EventEnvelope<UiEvent>),
    App(AppEvent),
}

#[derive(Clone)]
pub struct UiMailbox {
    pub(crate) sender: SyncSender<UiMessage>,
}

impl UiMailbox {
    pub fn send_input(&self, input: UiInput) -> Result<(), UiIngressError> {
        self.send_ui(EventEnvelope::focused(UiEvent::Input(input)))
    }

    pub fn send_ui(&self, event: EventEnvelope<UiEvent>) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::Ui(event))
    }

    pub fn send_content(&self, event: EventEnvelope<ContentEvent>) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::Content(Box::new(event)))
    }

    pub fn send_user(&self, intent: UserIntent) -> Result<(), UiIngressError> {
        self.send_app(AppEvent::User(intent))
    }

    pub fn send_app(&self, event: AppEvent) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::App(event))
    }

    pub fn send_backend(&self, output: BackendOutput) -> Result<(), UiIngressError> {
        self.send_content(EventEnvelope::broadcast(ContentEvent::Backend(Box::new(
            output,
        ))))
    }

    pub fn request_refresh(&self) -> Result<(), UiIngressError> {
        self.try_send_coalescible(UiMessage::Content(Box::new(EventEnvelope::broadcast(
            ContentEvent::RefreshRequested,
        ))))
    }

    pub fn tick(&self) -> Result<(), UiIngressError> {
        self.try_send_coalescible(UiMessage::Content(Box::new(EventEnvelope::broadcast(
            ContentEvent::ClockTick,
        ))))
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
