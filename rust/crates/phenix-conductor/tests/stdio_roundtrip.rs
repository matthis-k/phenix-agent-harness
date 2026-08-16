use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    AuthenticationState, BackendCatalog, BackendId, ExecutionEventKind, ExecutionTarget,
    InferenceOptions, ModelDescriptor, ModelId, ModelTarget, ProviderId, SessionId,
};
use phenix_protocol::{ClientMessage, Command, ResponsePayload, ServerMessage};
use std::collections::BTreeSet;
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};

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
