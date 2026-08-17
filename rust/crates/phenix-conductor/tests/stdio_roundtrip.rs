use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    AuthenticationState, BackendCatalog, BackendId, ExecutionEventKind, ExecutionTarget,
    InferenceOptions, ModelDescriptor, ModelId, ModelTarget, ProviderId, SessionId,
};
use phenix_protocol::{ClientMessage, Command, Reply, ResponsePayload, ServerMessage};
use std::collections::BTreeSet;
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};

#[path = "support/protocol_public_journeys.rs"]
mod protocol_public_journeys;
#[path = "support/server_cancellation.rs"]
mod server_cancellation;

struct MockBackend;
struct MockSession;

impl Backend for MockBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::new(),
            images: false,
            persistent_sessions: false,
        }
    }

    fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
        Ok(BackendCatalog {
            backend: BackendId::parse("mock").unwrap(),
            models: vec![ModelDescriptor {
                target: fixed_model(),
                name: "Mock Model".to_owned(),
                selectable: true,
            }],
            authentication_state: AuthenticationState::NotRequired,
            authentication_methods: Vec::new(),
        })
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        assert_eq!(request.model, fixed_model());
        Ok(Arc::new(MockSession))
    }
}

impl BackendSession for MockSession {
    fn execute(
        &self,
        _request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        host.emit(BackendEvent::ReasoningDelta("think".to_owned()))?;
        host.emit(BackendEvent::ContentDelta("answer".to_owned()))?;
        Ok(())
    }

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

#[derive(Clone, Default)]
struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn fixed_model() -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock-provider").unwrap(),
        model: ModelId::parse("mock-model").unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn line(message: ClientMessage) -> String {
    format!("{}\n", serde_json::to_string(&message).unwrap())
}

#[test]
fn stdio_server_runs_a_model_turn_over_phenix_protocol() {
    let mut server = ConductorServer::new(ConductorRuntime::new());
    server
        .register_backend(BackendId::parse("mock").unwrap(), Box::new(MockBackend))
        .unwrap();

    let input = [
        line(ClientMessage {
            id: 1,
            command: Command::Initialize {
                after_sequence: Some(0),
            },
        }),
        line(ClientMessage {
            id: 2,
            command: Command::CreateSession {
                parent_session: None,
                name: Some("test".to_owned()),
                target: ExecutionTarget::Fixed(fixed_model()),
            },
        }),
        line(ClientMessage {
            id: 3,
            command: Command::Submit {
                session_id: SessionId::parse("session-1").unwrap(),
                text: "hello".to_owned(),
            },
        }),
    ]
    .concat();
    let writer = SharedWriter::default();
    let captured = writer.0.clone();

    server
        .serve_ndjson(Cursor::new(input.into_bytes()), writer)
        .unwrap();

    let bytes = captured.lock().unwrap().clone();
    let messages = String::from_utf8(bytes)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<ServerMessage>(line).unwrap())
        .collect::<Vec<_>>();

    for id in 1..=3 {
        assert!(messages.iter().any(|message| {
            matches!(
                message,
                ServerMessage::Response {
                    id: response_id,
                    response: ResponsePayload::Ok { .. },
                } if *response_id == id
            )
        }));
    }
    assert!(messages.iter().any(|message| {
        matches!(
            message,
            ServerMessage::Event { event }
                if matches!(
                    &event.kind,
                    ExecutionEventKind::ReasoningDelta { text } if text == "think"
                )
        )
    }));
    assert!(messages.iter().any(|message| {
        matches!(
            message,
            ServerMessage::Event { event }
                if matches!(
                    &event.kind,
                    ExecutionEventKind::AssistantContentDelta { text } if text == "answer"
                )
        )
    }));
}

#[cfg(unix)]
mod unix_service {
    use super::*;
    use std::fs;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command as ProcessCommand, Stdio};
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    fn unique_paths() -> (PathBuf, PathBuf, PathBuf) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "phenix-conductor-service-{}-{unique}",
            std::process::id()
        ));
        (
            root.clone(),
            root.join("conductor.sock"),
            root.join("state.json"),
        )
    }

    fn spawn_service(socket: &Path, state: &Path) -> Child {
        ProcessCommand::new(env!("CARGO_BIN_EXE_phenix-conductor"))
            .arg("--socket")
            .arg(socket)
            .arg("--state")
            .arg(state)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn local conductor service")
    }

    fn connect_service(child: &mut Child, socket: &Path) -> UnixStream {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match UnixStream::connect(socket) {
                Ok(stream) => return stream,
                Err(error) if Instant::now() < deadline => {
                    if let Some(status) = child.try_wait().expect("inspect conductor process") {
                        panic!("conductor exited before socket became ready: {status}: {error}");
                    }
                    thread::yield_now();
                }
                Err(error) => panic!("conductor socket did not become ready: {error}"),
            }
        }
    }

    fn request(
        writer: &mut UnixStream,
        reader: &mut BufReader<UnixStream>,
        message: ClientMessage,
    ) -> Reply {
        let id = message.id;
        writer.write_all(line(message).as_bytes()).unwrap();
        writer.flush().unwrap();

        loop {
            let mut response_line = String::new();
            assert!(reader.read_line(&mut response_line).unwrap() > 0);
            let message = serde_json::from_str::<ServerMessage>(&response_line).unwrap();
            match message {
                ServerMessage::Response {
                    id: response_id,
                    response: ResponsePayload::Ok { result },
                } if response_id == id => return result,
                ServerMessage::Response {
                    id: response_id,
                    response: ResponsePayload::Error { error },
                } if response_id == id => panic!("request {id} failed: {error:?}"),
                _ => {}
            }
        }
    }

    fn initialize(stream: &UnixStream, id: u64) -> Reply {
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        request(
            &mut writer,
            &mut reader,
            ClientMessage {
                id,
                command: Command::Initialize {
                    after_sequence: Some(0),
                },
            },
        )
    }

    #[test]
    fn unix_service_reconnects_frontends_and_restores_same_state_after_process_restart() {
        let (root, socket, state) = unique_paths();
        fs::create_dir_all(&root).unwrap();

        let mut first_process = spawn_service(&socket, &state);
        let first_stream = connect_service(&mut first_process, &socket);
        let mut writer = first_stream.try_clone().unwrap();
        let mut reader = BufReader::new(first_stream.try_clone().unwrap());

        let Reply::Initialized { snapshot, .. } = request(
            &mut writer,
            &mut reader,
            ClientMessage {
                id: 1,
                command: Command::Initialize {
                    after_sequence: Some(0),
                },
            },
        ) else {
            panic!("initialize returned wrong reply");
        };
        assert!(snapshot.sessions.is_empty());

        let Reply::Session { session } = request(
            &mut writer,
            &mut reader,
            ClientMessage {
                id: 2,
                command: Command::CreateSession {
                    parent_session: None,
                    name: Some("durable".to_owned()),
                    target: ExecutionTarget::Fixed(fixed_model()),
                },
            },
        ) else {
            panic!("create session returned wrong reply");
        };
        assert_eq!(session.id, SessionId::parse("session-1").unwrap());
        assert!(state.exists(), "service did not persist its journal");

        drop(reader);
        drop(writer);
        drop(first_stream);

        let reconnect = connect_service(&mut first_process, &socket);
        let Reply::Initialized { snapshot, .. } = initialize(&reconnect, 3) else {
            panic!("reconnect initialize returned wrong reply");
        };
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.sessions[0].name.as_deref(), Some("durable"));
        drop(reconnect);

        first_process.kill().unwrap();
        first_process.wait().unwrap();
        if socket.exists() {
            fs::remove_file(&socket).unwrap();
        }

        let mut restarted_process = spawn_service(&socket, &state);
        let restarted = connect_service(&mut restarted_process, &socket);
        let Reply::Initialized { snapshot, .. } = initialize(&restarted, 4) else {
            panic!("restart initialize returned wrong reply");
        };
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(
            snapshot.sessions[0].id,
            SessionId::parse("session-1").unwrap()
        );
        assert_eq!(snapshot.sessions[0].name.as_deref(), Some("durable"));

        drop(restarted);
        restarted_process.kill().unwrap();
        restarted_process.wait().unwrap();
        let _ = fs::remove_dir_all(root);
    }
}
