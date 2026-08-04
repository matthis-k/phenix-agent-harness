#![forbid(unsafe_code)]

use phenix_runtime_api::{BackendClient, BackendOutput, BackendRuntime, BackendWorker};
use phenix_ui_core::{reduce, AppEffect, AppEvent, AppState, UserIntent};
use std::collections::VecDeque;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const DEFAULT_DRAIN_LIMIT: usize = 256;

#[derive(Debug, Eq, PartialEq)]
pub enum UiMessage {
    User(UserIntent),
    Backend(BackendOutput),
    Tick,
    Refresh,
    Shutdown,
}

#[derive(Clone)]
pub struct UiMailbox {
    sender: SyncSender<UiMessage>,
}

impl UiMailbox {
    pub fn send_user(&self, intent: UserIntent) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::User(intent))
    }

    pub fn send_backend(&self, output: BackendOutput) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::Backend(output))
    }

    pub fn request_refresh(&self) -> Result<(), UiIngressError> {
        self.try_send_coalescible(UiMessage::Refresh)
    }

    pub fn tick(&self) -> Result<(), UiIngressError> {
        self.try_send_coalescible(UiMessage::Tick)
    }

    pub fn shutdown(&self) -> Result<(), UiIngressError> {
        self.send_lossless(UiMessage::Shutdown)
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

pub struct UiRuntime<R> {
    state: AppState,
    backend: BackendClient,
    renderer: R,
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

    pub fn set_drain_limit(&mut self, drain_limit: usize) -> Result<(), UiRuntimeError> {
        if drain_limit == 0 {
            return Err(UiRuntimeError::InvalidConfiguration(
                "UI drain limit must be positive".to_owned(),
            ));
        }
        self.drain_limit = drain_limit;
        Ok(())
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

            for _ in 1..self.drain_limit {
                match self.receiver.try_recv() {
                    Ok(message) => dirty |= self.apply(message),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        if !self.state.should_quit {
                            return Err(UiRuntimeError::Disconnected);
                        }
                        break;
                    }
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
        match message {
            UiMessage::User(intent) => self.apply_event(AppEvent::User(intent)),
            UiMessage::Backend(output) => self.apply_event(AppEvent::Backend(output)),
            UiMessage::Tick | UiMessage::Refresh => true,
            UiMessage::Shutdown => self.apply_event(AppEvent::User(UserIntent::Quit)),
        }
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
    use phenix_runtime_api::{
        AgentBackend, BackendError, BackendOutputSender, BackendReply, BackendRequest,
    };
    use std::sync::{Arc, Mutex};

    struct AcceptingBackend;

    impl AgentBackend for AcceptingBackend {
        fn run(
            self: Box<Self>,
            requests: Receiver<BackendRequest>,
            outputs: BackendOutputSender,
        ) -> Result<(), BackendError> {
            for request in requests {
                let shutdown = matches!(
                    request.command,
                    phenix_runtime_api::BackendCommand::Shutdown
                );
                outputs.reply(request.id, Ok(BackendReply::Accepted))?;
                if shutdown {
                    return Ok(());
                }
            }
            Ok(())
        }
    }

    struct RecordingRenderer {
        thread_ids: Arc<Mutex<Vec<thread::ThreadId>>>,
        input_values: Arc<Mutex<Vec<String>>>,
    }

    impl UiRenderer for RecordingRenderer {
        fn render(&mut self, state: &AppState) -> Result<(), String> {
            self.thread_ids
                .lock()
                .expect("thread recorder lock")
                .push(thread::current().id());
            self.input_values
                .lock()
                .expect("input recorder lock")
                .push(state.input.text.clone());
            Ok(())
        }
    }

    #[test]
    fn all_producers_converge_on_one_state_and_render_owner() {
        let backend = BackendRuntime::spawn(Box::new(AcceptingBackend), 8).expect("backend");
        let thread_ids = Arc::new(Mutex::new(Vec::new()));
        let input_values = Arc::new(Mutex::new(Vec::new()));
        let renderer = RecordingRenderer {
            thread_ids: Arc::clone(&thread_ids),
            input_values: Arc::clone(&input_values),
        };
        let runtime = UiRuntime::from_backend(AppState::default(), backend, renderer, 8)
            .expect("UI runtime");
        let mailbox = runtime.mailbox();
        let producer = thread::spawn(move || {
            mailbox
                .send_user(UserIntent::InputChanged("owned by UI loop".to_owned()))
                .expect("send input");
            mailbox.request_refresh().ok();
            mailbox.shutdown().expect("send shutdown");
        });
        let owner_thread = thread::current().id();
        let state = runtime.run().expect("run UI");
        producer.join().expect("producer joins");

        assert!(state.should_quit);
        assert_eq!(state.input.text, "owned by UI loop");
        assert!(thread_ids
            .lock()
            .expect("thread recorder lock")
            .iter()
            .all(|thread_id| *thread_id == owner_thread));
        assert!(input_values
            .lock()
            .expect("input recorder lock")
            .iter()
            .any(|value| value == "owned by UI loop"));
    }

    #[test]
    fn ticks_are_coalescible_but_semantic_messages_are_lossless() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mailbox = UiMailbox { sender };
        mailbox.tick().expect("first tick fills queue");
        assert_eq!(mailbox.tick(), Err(UiIngressError::Coalesced));
        assert_eq!(receiver.recv().expect("receive tick"), UiMessage::Tick);
    }

    #[test]
    fn zero_capacity_is_rejected_before_threads_are_started() {
        let backend = BackendRuntime::spawn(Box::new(AcceptingBackend), 1).expect("backend");
        let renderer = RecordingRenderer {
            thread_ids: Arc::new(Mutex::new(Vec::new())),
            input_values: Arc::new(Mutex::new(Vec::new())),
        };
        let error = UiRuntime::from_backend(AppState::default(), backend, renderer, 0)
            .err()
            .expect("invalid capacity");
        assert!(matches!(
            error,
            UiRuntimeError::InvalidConfiguration(_)
        ));
    }
}
