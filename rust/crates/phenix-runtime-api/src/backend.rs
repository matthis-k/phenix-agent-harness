use crate::id::RequestId;
use crate::protocol::{BackendCommand, BackendEvent, BackendReply};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

pub trait AgentBackend: Send + 'static {
    fn run(
        self: Box<Self>,
        requests: Receiver<BackendRequest>,
        outputs: BackendOutputSender,
    ) -> Result<(), BackendError>;
}

#[derive(Debug, Eq, PartialEq)]
pub struct BackendRequest {
    pub id: RequestId,
    pub command: BackendCommand,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendOutput {
    Reply {
        request_id: RequestId,
        result: Result<BackendReply, BackendError>,
    },
    Event(BackendEvent),
    Stopped {
        result: Result<(), BackendError>,
    },
}

#[derive(Clone)]
pub struct BackendOutputSender {
    outputs: SyncSender<BackendOutput>,
}

impl BackendOutputSender {
    pub fn reply(
        &self,
        request_id: RequestId,
        result: Result<BackendReply, BackendError>,
    ) -> Result<(), BackendError> {
        self.send(BackendOutput::Reply { request_id, result })
    }

    pub fn event(&self, event: BackendEvent) -> Result<(), BackendError> {
        self.send(BackendOutput::Event(event))
    }

    fn send(&self, output: BackendOutput) -> Result<(), BackendError> {
        self.outputs
            .send(output)
            .map_err(|_| BackendError::Disconnected)
    }
}

#[derive(Clone)]
pub struct BackendClient {
    requests: SyncSender<BackendRequest>,
    next_request: Arc<AtomicU64>,
}

impl BackendClient {
    pub fn submit(&self, command: BackendCommand) -> Result<RequestId, BackendError> {
        let sequence = self
            .next_request
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map_err(|_| BackendError::RequestIdExhausted)?;
        let id = RequestId::parse(format!("request-{sequence}"))
            .map_err(|error| BackendError::InvalidConfiguration(error.to_string()))?;
        let request = BackendRequest {
            id: id.clone(),
            command,
        };
        match self.requests.try_send(request) {
            Ok(()) => Ok(id),
            Err(TrySendError::Full(_)) => Err(BackendError::Backpressure),
            Err(TrySendError::Disconnected(_)) => Err(BackendError::Disconnected),
        }
    }
}

pub struct BackendRuntime {
    pub client: BackendClient,
    pub outputs: Receiver<BackendOutput>,
    worker: Option<JoinHandle<Result<(), BackendError>>>,
}

pub struct BackendWorker {
    worker: Option<JoinHandle<Result<(), BackendError>>>,
}

impl BackendWorker {
    pub fn join(mut self) -> Result<(), BackendError> {
        let worker = self.worker.take().ok_or_else(|| {
            BackendError::InvalidConfiguration("backend worker already joined".to_owned())
        })?;
        worker.join().map_err(|_| BackendError::Panicked)?
    }
}

impl Drop for BackendWorker {
    fn drop(&mut self) {
        // Dropping a damaged backend must not stall terminal restoration. The
        // orderly path sends Shutdown and explicitly joins the worker.
        let _ = self.worker.take();
    }
}

impl BackendRuntime {
    pub fn spawn(
        backend: Box<dyn AgentBackend>,
        channel_capacity: usize,
    ) -> Result<Self, BackendError> {
        if channel_capacity == 0 {
            return Err(BackendError::InvalidConfiguration(
                "backend channel capacity must be positive".to_owned(),
            ));
        }

        let (request_sender, requests) = mpsc::sync_channel(channel_capacity);
        let (output_sender, outputs) = mpsc::sync_channel(channel_capacity);
        let backend_outputs = BackendOutputSender {
            outputs: output_sender.clone(),
        };
        let worker = thread::Builder::new()
            .name("phenix-agent-backend".to_owned())
            .spawn(move || {
                let result = backend.run(requests, backend_outputs);
                let _ = output_sender.try_send(BackendOutput::Stopped {
                    result: result.clone(),
                });
                result
            })
            .map_err(|error| BackendError::Start(error.to_string()))?;

        Ok(Self {
            client: BackendClient {
                requests: request_sender,
                next_request: Arc::new(AtomicU64::new(1)),
            },
            outputs,
            worker: Some(worker),
        })
    }

    pub fn split(mut self) -> (BackendClient, Receiver<BackendOutput>, BackendWorker) {
        let (_unused_sender, empty_outputs) = mpsc::sync_channel(1);
        let outputs = std::mem::replace(&mut self.outputs, empty_outputs);
        let worker = BackendWorker {
            worker: self.worker.take(),
        };
        (self.client.clone(), outputs, worker)
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
        // The UI must never block while tearing down a damaged backend. Dropping
        // the runtime closes its channels; an explicit Shutdown command plus join
        // remains the orderly path.
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
    Backpressure,
    RequestIdExhausted,
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
            Self::Backpressure => formatter.write_str("backend request queue is full"),
            Self::RequestIdExhausted => formatter.write_str("backend request IDs are exhausted"),
            Self::Disconnected => formatter.write_str("backend disconnected"),
            Self::Panicked => formatter.write_str("backend worker panicked"),
        }
    }
}

impl Error for BackendError {}

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
            outputs: BackendOutputSender,
        ) -> Result<(), BackendError> {
            for request in requests {
                let response = match request.command {
                    BackendCommand::SnapshotRequest => BackendReply::Models(Vec::new()),
                    BackendCommand::Shutdown => {
                        outputs.reply(request.id, Ok(BackendReply::Completed))?;
                        return Ok(());
                    }
                    BackendCommand::Initialize { .. } => BackendReply::Initialized {
                        capabilities: BackendCapabilities::default(),
                        snapshot: RuntimeSnapshot {
                            capabilities: BackendCapabilities::default(),
                            health: BackendHealth::Ready,
                            active_session: None,
                            root_run: None,
                            selected_run: None,
                            sessions: Vec::new(),
                            runs: Vec::new(),
                            objectives: Vec::new(),
                        },
                    },
                    _ => BackendReply::Accepted,
                };
                outputs.reply(request.id, Ok(response))?;
            }
            Ok(())
        }
    }

    #[test]
    fn boxed_backend_is_owned_by_one_driver_thread_without_blocking_the_client() {
        let runtime = BackendRuntime::spawn(Box::new(EchoBackend), 4).expect("spawn backend");
        let snapshot_request = runtime
            .client
            .submit(BackendCommand::SnapshotRequest)
            .expect("submit snapshot request");
        assert_eq!(
            runtime.outputs.recv().expect("receive snapshot reply"),
            BackendOutput::Reply {
                request_id: snapshot_request,
                result: Ok(BackendReply::Models(Vec::new())),
            }
        );

        let shutdown_request = runtime
            .client
            .submit(BackendCommand::Shutdown)
            .expect("submit shutdown request");
        assert_eq!(
            runtime.outputs.recv().expect("receive shutdown reply"),
            BackendOutput::Reply {
                request_id: shutdown_request,
                result: Ok(BackendReply::Completed),
            }
        );
        runtime.join().expect("backend joins cleanly");
    }

    #[test]
    fn runtime_splits_into_nonblocking_client_output_stream_and_worker_handle() {
        let runtime = BackendRuntime::spawn(Box::new(EchoBackend), 4).expect("spawn backend");
        let (client, outputs, worker) = runtime.split();
        let shutdown_request = client
            .submit(BackendCommand::Shutdown)
            .expect("submit shutdown request");
        assert_eq!(
            outputs.recv().expect("receive shutdown reply"),
            BackendOutput::Reply {
                request_id: shutdown_request,
                result: Ok(BackendReply::Completed),
            }
        );
        worker.join().expect("backend joins cleanly");
    }

    #[test]
    fn bounded_request_queue_reports_backpressure_instead_of_blocking() {
        let (requests, _receiver) = mpsc::sync_channel(1);
        let client = BackendClient {
            requests,
            next_request: Arc::new(AtomicU64::new(1)),
        };
        client
            .submit(BackendCommand::SnapshotRequest)
            .expect("first request fills queue");
        assert_eq!(
            client.submit(BackendCommand::SnapshotRequest),
            Err(BackendError::Backpressure)
        );
    }

    #[test]
    fn rejects_zero_capacity_instead_of_constructing_a_rendezvous_deadlock() {
        let error = BackendRuntime::spawn(Box::new(EchoBackend), 0)
            .err()
            .expect("zero capacity is invalid");
        assert!(matches!(error, BackendError::InvalidConfiguration(_)));
    }
}
