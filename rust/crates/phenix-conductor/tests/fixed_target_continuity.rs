use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    BackendId, ExecutionEventKind, ExecutionId, ExecutionTarget, InferenceOptions, ModelId,
    ModelTarget, ProviderId, SessionId,
};
use phenix_protocol::{ClientMessage, Command, ServerMessage};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

#[derive(Default)]
struct PersistentBackendState {
    persistent_opens: Mutex<Vec<SessionId>>,
    native_sessions_created: AtomicUsize,
    ephemeral_opens: AtomicUsize,
}

struct PersistentBackend {
    state: Arc<PersistentBackendState>,
    sessions: BTreeMap<SessionId, Arc<PersistentSession>>,
}

impl PersistentBackend {
    fn new(state: Arc<PersistentBackendState>) -> Self {
        Self {
            state,
            sessions: BTreeMap::new(),
        }
    }
}

impl Backend for PersistentBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::new(),
            images: false,
            persistent_sessions: true,
        }
    }

    fn open_session(
        &mut self,
        _request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        self.state.ephemeral_opens.fetch_add(1, Ordering::SeqCst);
        Err(BackendError::Protocol(
            "fixed targets with persistent support must not use ephemeral opening".to_owned(),
        ))
    }

    fn open_persistent_session(
        &mut self,
        session_id: &SessionId,
        _request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        self.state
            .persistent_opens
            .lock()
            .unwrap()
            .push(session_id.clone());
        let session = self
            .sessions
            .entry(session_id.clone())
            .or_insert_with(|| {
                self.state
                    .native_sessions_created
                    .fetch_add(1, Ordering::SeqCst);
                Arc::new(PersistentSession {
                    turn: AtomicUsize::new(0),
                })
            })
            .clone();
        Ok(session)
    }
}

struct PersistentSession {
    turn: AtomicUsize,
}

impl BackendSession for PersistentSession {
    fn execute(
        &self,
        _request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        let turn = self.turn.fetch_add(1, Ordering::SeqCst) + 1;
        host.emit(BackendEvent::ContentDelta(format!("turn:{turn}")))
    }

    fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

fn model_target() -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("persistent-mock").unwrap(),
        provider: ProviderId::parse("mock-provider").unwrap(),
        model: ModelId::parse("mock-model").unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn encode(commands: impl IntoIterator<Item = Command>) -> Vec<u8> {
    commands
        .into_iter()
        .enumerate()
        .map(|(index, command)| {
            serde_json::to_string(&ClientMessage {
                id: u64::try_from(index).unwrap() + 1,
                command,
            })
            .unwrap()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .into_bytes()
}

#[test]
fn fixed_target_turns_reuse_one_native_conversation_per_phenix_session() {
    let state = Arc::new(PersistentBackendState::default());
    let mut server = ConductorServer::new(ConductorRuntime::new());
    server
        .register_backend(
            BackendId::parse("persistent-mock").unwrap(),
            Box::new(PersistentBackend::new(state.clone())),
        )
        .unwrap();

    let input = encode([
        Command::CreateSession {
            parent_session: None,
            name: Some("first".to_owned()),
            target: ExecutionTarget::Fixed(model_target()),
        },
        Command::Submit {
            session_id: SessionId::parse("session-1").unwrap(),
            text: "remember alpha".to_owned(),
        },
        Command::Submit {
            session_id: SessionId::parse("session-1").unwrap(),
            text: "what did I say?".to_owned(),
        },
        Command::CreateSession {
            parent_session: None,
            name: Some("second".to_owned()),
            target: ExecutionTarget::Fixed(model_target()),
        },
        Command::Submit {
            session_id: SessionId::parse("session-2").unwrap(),
            text: "independent".to_owned(),
        },
    ]);
    let mut output = Vec::new();
    server
        .serve_ndjson(Cursor::new(input), &mut output)
        .unwrap();

    let content = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<ServerMessage>(line).unwrap())
        .filter_map(|message| match message {
            ServerMessage::Event { event } => match event.kind {
                ExecutionEventKind::AssistantContentDelta { text } => {
                    Some((event.execution_id, text))
                }
                _ => None,
            },
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();

    assert_eq!(
        content.get(&ExecutionId::parse("execution-1").unwrap()),
        Some(&"turn:1".to_owned())
    );
    assert_eq!(
        content.get(&ExecutionId::parse("execution-2").unwrap()),
        Some(&"turn:2".to_owned())
    );
    assert_eq!(
        content.get(&ExecutionId::parse("execution-3").unwrap()),
        Some(&"turn:1".to_owned())
    );
    assert_eq!(state.ephemeral_opens.load(Ordering::SeqCst), 0);
    assert_eq!(state.native_sessions_created.load(Ordering::SeqCst), 2);
    let persistent_opens = state.persistent_opens.lock().unwrap();
    assert_eq!(
        persistent_opens
            .iter()
            .filter(|session_id| session_id.as_str() == "session-1")
            .count(),
        2
    );
    assert_eq!(
        persistent_opens
            .iter()
            .filter(|session_id| session_id.as_str() == "session-2")
            .count(),
        1
    );
}
