use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    AuthenticationMethodDescriptor, AuthenticationMethodId, AuthenticationMethodKind,
    AuthenticationState, BackendCatalog, BackendId, ExecutionState, ExecutionTarget,
    InferenceOptions, ModelDescriptor, ModelId, ModelTarget, ProviderId, SessionId,
};
use phenix_protocol::{ClientMessage, Command, ErrorCode, Reply, ResponsePayload, ServerMessage};
use std::collections::BTreeSet;
use std::io::{Cursor, Write};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};

#[derive(Clone, Default)]
struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl Write for CaptureWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode(message: ClientMessage) -> String {
    format!("{}\n", serde_json::to_string(&message).unwrap())
}

fn decode(captured: &Arc<Mutex<Vec<u8>>>) -> Vec<ServerMessage> {
    String::from_utf8(captured.lock().unwrap().clone())
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<ServerMessage>(line).unwrap())
        .collect()
}

fn ok_reply(messages: &[ServerMessage], expected_id: u64) -> &Reply {
    messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::Response {
                id,
                response: ResponsePayload::Ok { result },
            } if *id == expected_id => Some(result),
            _ => None,
        })
        .unwrap_or_else(|| panic!("request {expected_id} did not return an ok reply"))
}

fn error_code(messages: &[ServerMessage], expected_id: u64) -> ErrorCode {
    messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::Response {
                id,
                response: ResponsePayload::Error { error },
            } if *id == expected_id => Some(error.code.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("request {expected_id} did not return an error"))
}

#[test]
fn malformed_ndjson_is_rejected_without_poisoning_following_requests() {
    let mut server = ConductorServer::new(ConductorRuntime::new());
    let input = format!(
        "{{ definitely-not-json }}\n{}",
        encode(ClientMessage {
            id: 1,
            command: Command::GetSnapshot,
        })
    );
    let writer = CaptureWriter::default();
    let captured = writer.0.clone();

    server
        .serve_ndjson(Cursor::new(input.into_bytes()), writer)
        .unwrap();

    let messages = decode(&captured);
    assert_eq!(error_code(&messages, 0), ErrorCode::InvalidRequest);
    assert!(matches!(ok_reply(&messages, 1), Reply::Snapshot { .. }));
}

struct AuthState {
    authenticated: AtomicBool,
    auth_calls: AtomicUsize,
    opened_models: Mutex<Vec<ModelTarget>>,
}

impl Default for AuthState {
    fn default() -> Self {
        Self {
            authenticated: AtomicBool::new(false),
            auth_calls: AtomicUsize::new(0),
            opened_models: Mutex::new(Vec::new()),
        }
    }
}

struct AuthBackend {
    state: Arc<AuthState>,
}

struct AuthSession;

fn auth_backend_id() -> BackendId {
    BackendId::parse("auth-fixture").unwrap()
}

fn auth_provider_id() -> ProviderId {
    ProviderId::parse("auth-provider").unwrap()
}

fn auth_model(name: &str) -> ModelTarget {
    ModelTarget {
        backend: auth_backend_id(),
        provider: auth_provider_id(),
        model: ModelId::parse(name).unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn login_method() -> AuthenticationMethodDescriptor {
    AuthenticationMethodDescriptor {
        id: AuthenticationMethodId::parse("login").unwrap(),
        backend: auth_backend_id(),
        provider: auth_provider_id(),
        kind: AuthenticationMethodKind::Agent,
        name: "Fixture login".to_owned(),
        description: Some("Authenticate the fixture backend".to_owned()),
        selectable: true,
    }
}

impl Backend for AuthBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::new(),
            images: false,
            persistent_sessions: false,
        }
    }

    fn catalog(&mut self) -> Result<BackendCatalog, BackendError> {
        Ok(BackendCatalog {
            backend: auth_backend_id(),
            models: vec![
                ModelDescriptor {
                    target: auth_model("alpha"),
                    name: "Alpha".to_owned(),
                    selectable: true,
                },
                ModelDescriptor {
                    target: auth_model("beta"),
                    name: "Beta".to_owned(),
                    selectable: true,
                },
            ],
            authentication_state: if self.state.authenticated.load(Ordering::SeqCst) {
                AuthenticationState::Authenticated
            } else {
                AuthenticationState::Required
            },
            authentication_methods: vec![login_method()],
        })
    }

    fn authenticate(&mut self, method: &AuthenticationMethodId) -> Result<(), BackendError> {
        if method.as_str() != "login" {
            return Err(BackendError::Protocol(format!(
                "unknown authentication method: {method}"
            )));
        }
        self.state.auth_calls.fetch_add(1, Ordering::SeqCst);
        self.state.authenticated.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        if !self.state.authenticated.load(Ordering::SeqCst) {
            return Err(BackendError::Protocol(
                "fixture backend is not authenticated".to_owned(),
            ));
        }
        self.state.opened_models.lock().unwrap().push(request.model);
        Ok(Arc::new(AuthSession))
    }
}

impl BackendSession for AuthSession {
    fn execute(
        &self,
        _request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        host.emit(BackendEvent::ContentDelta(
            "authenticated answer".to_owned(),
        ))?;
        Ok(())
    }

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

#[test]
fn catalog_authentication_and_model_retarget_form_one_serialized_journey() {
    let state = Arc::new(AuthState::default());
    let mut server = ConductorServer::new(ConductorRuntime::new());
    server
        .register_backend(
            auth_backend_id(),
            Box::new(AuthBackend {
                state: state.clone(),
            }),
        )
        .unwrap();

    let input = [
        encode(ClientMessage {
            id: 1,
            command: Command::Initialize {
                after_sequence: Some(0),
            },
        }),
        encode(ClientMessage {
            id: 2,
            command: Command::SelectAuthentication {
                backend_id: auth_backend_id(),
                method_id: AuthenticationMethodId::parse("login").unwrap(),
                input: None,
            },
        }),
        encode(ClientMessage {
            id: 3,
            command: Command::CreateSession {
                parent_session: None,
                name: Some("auth journey".to_owned()),
                target: ExecutionTarget::Fixed(auth_model("alpha")),
            },
        }),
        encode(ClientMessage {
            id: 4,
            command: Command::SetSessionTarget {
                session_id: SessionId::parse("session-1").unwrap(),
                target: ExecutionTarget::Fixed(auth_model("beta")),
            },
        }),
        encode(ClientMessage {
            id: 5,
            command: Command::Submit {
                session_id: SessionId::parse("session-1").unwrap(),
                text: "authenticated prompt".to_owned(),
            },
        }),
    ]
    .concat();
    let writer = CaptureWriter::default();
    let captured = writer.0.clone();

    server
        .serve_ndjson(Cursor::new(input.into_bytes()), writer)
        .unwrap();

    let messages = decode(&captured);
    let Reply::Initialized { backends, .. } = ok_reply(&messages, 1) else {
        panic!("initialize returned the wrong reply");
    };
    assert_eq!(backends.len(), 1);
    assert_eq!(
        backends[0].authentication_state,
        AuthenticationState::Required
    );
    assert_eq!(backends[0].models.len(), 2);
    assert_eq!(backends[0].authentication_methods, vec![login_method()]);

    let Reply::BackendCatalog { catalog } = ok_reply(&messages, 2) else {
        panic!("authentication returned the wrong reply");
    };
    assert_eq!(
        catalog.authentication_state,
        AuthenticationState::Authenticated
    );
    assert_eq!(state.auth_calls.load(Ordering::SeqCst), 1);

    let Reply::Session { session } = ok_reply(&messages, 4) else {
        panic!("retarget returned the wrong reply");
    };
    assert_eq!(
        session.default_target,
        ExecutionTarget::Fixed(auth_model("beta"))
    );
    assert!(matches!(ok_reply(&messages, 5), Reply::Execution { .. }));

    assert_eq!(
        state.opened_models.lock().unwrap().as_slice(),
        &[auth_model("beta")]
    );
    let runtime = server.runtime();
    let snapshot = runtime.snapshot();
    assert_eq!(snapshot.executions.len(), 1);
    assert_eq!(snapshot.executions[0].state, ExecutionState::Completed);
    assert_eq!(
        snapshot.executions[0].target,
        ExecutionTarget::Fixed(auth_model("beta"))
    );
}

#[test]
fn invalid_authentication_method_returns_backend_protocol_error_and_does_not_authenticate() {
    let state = Arc::new(AuthState::default());
    let mut server = ConductorServer::new(ConductorRuntime::new());
    server
        .register_backend(
            auth_backend_id(),
            Box::new(AuthBackend {
                state: state.clone(),
            }),
        )
        .unwrap();
    let input = [
        encode(ClientMessage {
            id: 1,
            command: Command::Initialize {
                after_sequence: Some(0),
            },
        }),
        encode(ClientMessage {
            id: 2,
            command: Command::SelectAuthentication {
                backend_id: auth_backend_id(),
                method_id: AuthenticationMethodId::parse("missing").unwrap(),
                input: None,
            },
        }),
    ]
    .concat();
    let writer = CaptureWriter::default();
    let captured = writer.0.clone();

    server
        .serve_ndjson(Cursor::new(input.into_bytes()), writer)
        .unwrap();

    let messages = decode(&captured);
    assert_eq!(error_code(&messages, 2), ErrorCode::BackendProtocol);
    assert_eq!(state.auth_calls.load(Ordering::SeqCst), 0);
    assert!(!state.authenticated.load(Ordering::SeqCst));
}
