use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    AuthenticationState, BackendCatalog, BackendId, ExecutionEventKind, ExecutionState,
    ExecutionTarget, InferenceOptions, ModelDescriptor, ModelId, ModelTarget, ProviderId,
    SessionId,
};
use phenix_protocol::{ClientMessage, Command, Reply, ResponsePayload, ServerMessage};
use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::thread;
use std::time::{Duration, Instant};

struct BlockingBackend {
    started: Arc<AtomicBool>,
    cancel_called: Arc<AtomicBool>,
    release: Arc<AtomicBool>,
    late_event_rejected: Arc<AtomicBool>,
}

struct BlockingSession {
    started: Arc<AtomicBool>,
    cancel_called: Arc<AtomicBool>,
    release: Arc<AtomicBool>,
    late_event_rejected: Arc<AtomicBool>,
}

fn target() -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("blocking").unwrap(),
        provider: ProviderId::parse("fixture").unwrap(),
        model: ModelId::parse("fixture-model").unwrap(),
        inference: InferenceOptions::default(),
    }
}

impl Backend for BlockingBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::new(),
            images: false,
            persistent_sessions: false,
        }
    }

    fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
        Ok(BackendCatalog {
            backend: BackendId::parse("blocking").unwrap(),
            models: vec![ModelDescriptor {
                target: target(),
                name: "Fixture Model".to_owned(),
            }],
            authentication_state: AuthenticationState::NotRequired,
            authentication_methods: Vec::new(),
        })
    }

    fn open_session(
        &mut self,
        _request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        Ok(Arc::new(BlockingSession {
            started: self.started.clone(),
            cancel_called: self.cancel_called.clone(),
            release: self.release.clone(),
            late_event_rejected: self.late_event_rejected.clone(),
        }))
    }
}

impl BackendSession for BlockingSession {
    fn execute(
        &self,
        _request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        self.started.store(true, Ordering::SeqCst);
        while !self.release.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(2));
        }
        if host
            .emit(BackendEvent::ContentDelta("late".to_owned()))
            .is_err()
        {
            self.late_event_rejected.store(true, Ordering::SeqCst);
        }
        Ok(())
    }

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        self.cancel_called.store(true, Ordering::SeqCst);
        self.release.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn send(stream: &mut UnixStream, id: u64, command: Command) {
    let message = ClientMessage { id, command };
    writeln!(stream, "{}", serde_json::to_string(&message).unwrap()).unwrap();
    stream.flush().unwrap();
}

fn read_response(reader: &mut BufReader<UnixStream>, expected_id: u64) -> Reply {
    loop {
        let mut line = String::new();
        assert_ne!(
            reader.read_line(&mut line).unwrap(),
            0,
            "server closed output"
        );
        let message: ServerMessage = serde_json::from_str(line.trim()).unwrap();
        if let ServerMessage::Response { id, response } = message {
            if id == expected_id {
                return match response {
                    ResponsePayload::Ok { result } => result,
                    ResponsePayload::Error { error } => {
                        panic!("request {expected_id} failed: {error:?}")
                    }
                };
            }
        }
    }
}

fn wait_until(flag: &AtomicBool, label: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !flag.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "timed out waiting for {label}");
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
fn active_turn_remains_queryable_and_cancellable() {
    let started = Arc::new(AtomicBool::new(false));
    let cancel_called = Arc::new(AtomicBool::new(false));
    let release = Arc::new(AtomicBool::new(false));
    let late_event_rejected = Arc::new(AtomicBool::new(false));

    let mut server = ConductorServer::new(ConductorRuntime::new());
    server
        .register_backend(
            BackendId::parse("blocking").unwrap(),
            Box::new(BlockingBackend {
                started: started.clone(),
                cancel_called: cancel_called.clone(),
                release: release.clone(),
                late_event_rejected: late_event_rejected.clone(),
            }),
        )
        .unwrap();

    let (mut frontend, server_socket) = UnixStream::pair().unwrap();
    frontend
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let server_input = BufReader::new(server_socket.try_clone().unwrap());
    let server_thread = thread::spawn(move || {
        server.serve_ndjson(server_input, server_socket).unwrap();
        server
    });
    let mut reader = BufReader::new(frontend.try_clone().unwrap());

    send(
        &mut frontend,
        1,
        Command::Initialize {
            after_sequence: Some(0),
        },
    );
    assert!(matches!(
        read_response(&mut reader, 1),
        Reply::Initialized { .. }
    ));

    send(
        &mut frontend,
        2,
        Command::CreateSession {
            parent_session: None,
            name: Some("root".to_owned()),
            target: ExecutionTarget::Fixed(target()),
        },
    );
    assert!(matches!(
        read_response(&mut reader, 2),
        Reply::Session { .. }
    ));

    send(
        &mut frontend,
        3,
        Command::Submit {
            session_id: SessionId::parse("session-1").unwrap(),
            text: "block".to_owned(),
        },
    );
    assert!(matches!(
        read_response(&mut reader, 3),
        Reply::Execution { .. }
    ));
    wait_until(&started, "backend execution to start");

    send(&mut frontend, 4, Command::GetSnapshot);
    let Reply::Snapshot { snapshot, .. } = read_response(&mut reader, 4) else {
        panic!("snapshot request returned the wrong reply");
    };
    assert_eq!(snapshot.executions.len(), 1);
    assert_eq!(snapshot.executions[0].state, ExecutionState::Running);

    send(
        &mut frontend,
        5,
        Command::CancelExecution {
            execution_id: phenix_core::ExecutionId::parse("execution-1").unwrap(),
        },
    );
    assert_eq!(read_response(&mut reader, 5), Reply::Accepted);
    wait_until(&cancel_called, "backend cancellation hook");
    wait_until(&late_event_rejected, "late backend event rejection");

    frontend.shutdown(Shutdown::Write).unwrap();
    let server = server_thread.join().unwrap();
    let runtime = server.runtime();
    let snapshot = runtime.snapshot();
    assert_eq!(snapshot.executions[0].state, ExecutionState::Cancelled);
    assert!(!runtime.events_since(0).iter().any(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::AssistantContentDelta { text } if text == "late"
        )
    }));
}
