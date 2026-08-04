use crate::protocol::{BackendCommand, BackendEvent, BackendReply};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::mpsc::{self, Receiver, RecvError, SyncSender};
use std::thread::{self, JoinHandle};

pub type DynAgentBackend = Box<dyn AgentBackend>;

pub trait AgentBackend: Send + 'static {
    fn run(
        self: Box<Self>,
        requests: Receiver<BackendRequest>,
        events: SyncSender<BackendEvent>,
    ) -> Result<(), BackendError>;
}

pub struct BackendRequest {
    pub command: BackendCommand,
    pub reply: SyncSender<Result<BackendReply, BackendError>>,
}

#[derive(Clone)]
pub struct BackendClient {
    requests: SyncSender<BackendRequest>,
}

impl BackendClient {
    pub fn request(&self, command: BackendCommand) -> Result<BackendReply, BackendError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.requests
            .send(BackendRequest { command, reply })
            .map_err(|_| BackendError::Disconnected)?;
        response.recv().map_err(|_| BackendError::Disconnected)?
    }
}

pub struct BackendRuntime {
    pub client: BackendClient,
    pub events: Receiver<BackendEvent>,
    worker: Option<JoinHandle<Result<(), BackendError>>>,
}

impl BackendRuntime {
    pub fn spawn(backend: DynAgentBackend, channel_capacity: usize) -> Result<Self, BackendError> {
        if channel_capacity == 0 {
            return Err(BackendError::InvalidConfiguration(
                "backend channel capacity must be positive".to_owned(),
            ));
        }

        let (request_sender, requests) = mpsc::sync_channel(channel_capacity);
        let (events, event_receiver) = mpsc::sync_channel(channel_capacity);
        let worker = thread::Builder::new()
            .name("phenix-agent-backend".to_owned())
            .spawn(move || backend.run(requests, events))
            .map_err(|error| BackendError::Start(error.to_string()))?;

        Ok(Self {
            client: BackendClient {
                requests: request_sender,
            },
            events: event_receiver,
            worker: Some(worker),
        })
    }

    pub fn join(mut self) -> Result<(), BackendError> {
        let worker = self.worker.take().ok_or_else(|| {
            BackendError::InvalidConfiguration("backend worker already joined".to_owned())
        })?;
        worker.join().map_err(|_| BackendError::Panicked)?
    }
}

impl Drop for BackendRuntime {
    fn drop(&mut self) {
        // Dropping the final client closes the request channel. Backends must treat
        // channel closure as a shutdown signal. The worker is intentionally not
        // joined from Drop because a blocking join would make UI teardown fragile.
        let _ = self.worker.take();
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendError {
    InvalidConfiguration(String),
    Start(String),
    Protocol(String),
    Transport(String),
    Unsupported(String),
    Disconnected,
    Panicked,
}

impl Display for BackendError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidConfiguration(message) => {
                write!(formatter, "invalid backend configuration: {message}")
            }
            Self::Start(message) => write!(formatter, "failed to start backend: {message}"),
            Self::Protocol(message) => write!(formatter, "backend protocol error: {message}"),
            Self::Transport(message) => write!(formatter, "backend transport error: {message}"),
            Self::Unsupported(message) => {
                write!(formatter, "backend operation is unsupported: {message}")
            }
            Self::Disconnected => formatter.write_str("backend disconnected"),
            Self::Panicked => formatter.write_str("backend worker panicked"),
        }
    }
}

impl Error for BackendError {}

impl From<RecvError> for BackendError {
    fn from(_: RecvError) -> Self {
        Self::Disconnected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        BackendCapabilities, BackendCommand, BackendHealth, BackendReply, RuntimeSnapshot,
    };

    struct EchoBackend;

    impl AgentBackend for EchoBackend {
        fn run(
            self: Box<Self>,
            requests: Receiver<BackendRequest>,
            _events: SyncSender<BackendEvent>,
        ) -> Result<(), BackendError> {
            for request in requests {
                let response = match request.command {
                    BackendCommand::SnapshotRequest => BackendReply::Models(Vec::new()),
                    BackendCommand::Shutdown => {
                        request
                            .reply
                            .send(Ok(BackendReply::Completed))
                            .map_err(|_| BackendError::Disconnected)?;
                        return Ok(());
                    }
                    BackendCommand::Initialize { .. } => BackendReply::Initialized {
                        capabilities: BackendCapabilities::default(),
                        snapshot: RuntimeSnapshot {
                            capabilities: BackendCapabilities::default(),
                            health: BackendHealth::Ready,
                            active_session: None,
                            sessions: Vec::new(),
                        },
                    },
                    _ => BackendReply::Accepted,
                };
                request
                    .reply
                    .send(Ok(response))
                    .map_err(|_| BackendError::Disconnected)?;
            }
            Ok(())
        }
    }

    #[test]
    fn boxed_backend_is_owned_by_one_driver_thread() {
        let runtime = BackendRuntime::spawn(Box::new(EchoBackend), 4).expect("spawn backend");
        assert_eq!(
            runtime
                .client
                .request(BackendCommand::SnapshotRequest)
                .expect("request succeeds"),
            BackendReply::Models(Vec::new())
        );
        assert_eq!(
            runtime
                .client
                .request(BackendCommand::Shutdown)
                .expect("shutdown succeeds"),
            BackendReply::Completed
        );
        runtime.join().expect("backend joins cleanly");
    }

    #[test]
    fn rejects_zero_capacity_instead_of_constructing_a_rendezvous_deadlock() {
        let error = BackendRuntime::spawn(Box::new(EchoBackend), 0)
            .err()
            .expect("zero capacity is invalid");
        assert!(matches!(error, BackendError::InvalidConfiguration(_)));
    }
}
