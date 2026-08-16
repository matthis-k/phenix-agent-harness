use phenix_backend::{
    Backend, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSessionRequest, ToolInvocation, ToolProvision, ToolResult,
};
use phenix_backend_acp::{AcpBackend, AcpBackendConfig};
use phenix_core::{
    BackendId, ExecutionId, InferenceOptions, ModelId, ModelTarget, ProviderId, SessionId,
};

#[derive(Default)]
struct CollectingHost {
    content: String,
}

impl BackendHost for CollectingHost {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError> {
        if let BackendEvent::ContentDelta(text) = event {
            self.content.push_str(&text);
        }
        Ok(())
    }

    fn invoke_tool(&mut self, _invocation: ToolInvocation) -> Result<ToolResult, BackendError> {
        Err(BackendError::Unsupported(
            "continuity fixture does not expose tools".to_owned(),
        ))
    }
}

fn target() -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("fixture-acp").unwrap(),
        provider: ProviderId::parse("fixture-provider").unwrap(),
        model: ModelId::parse("fixture-model").unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn session_request(backend: &AcpBackend) -> BackendSessionRequest {
    BackendSessionRequest {
        model: target(),
        tools: ToolProvision::default()
            .prepare(&backend.capabilities())
            .unwrap(),
    }
}

fn execute(
    session: &std::sync::Arc<dyn phenix_backend::BackendSession>,
    execution_id: &str,
    prompt: &str,
) -> String {
    let mut host = CollectingHost::default();
    session
        .execute(
            BackendExecutionRequest {
                execution_id: ExecutionId::parse(execution_id).unwrap(),
                prompt: prompt.to_owned(),
            },
            &mut host,
        )
        .unwrap();
    host.content
}

#[test]
fn stable_phenix_session_reuses_one_native_acp_conversation() {
    let fixture = env!("CARGO_BIN_EXE_acp-continuity-fixture");
    let cwd = std::env::current_dir().unwrap();
    let mut backend = AcpBackend::new(AcpBackendConfig::new(
        BackendId::parse("fixture-acp").unwrap(),
        ProviderId::parse("fixture-provider").unwrap(),
        fixture,
        cwd,
    ));

    let first_id = SessionId::parse("phenix-session-1").unwrap();
    let first = backend
        .open_persistent_session(&first_id, session_request(&backend))
        .unwrap();
    assert_eq!(execute(&first, "execution-1", "first"), "turn:1");

    let first_again = backend
        .open_persistent_session(&first_id, session_request(&backend))
        .unwrap();
    assert!(std::sync::Arc::ptr_eq(&first, &first_again));
    assert_eq!(execute(&first_again, "execution-2", "second"), "turn:2");

    let second_id = SessionId::parse("phenix-session-2").unwrap();
    let second = backend
        .open_persistent_session(&second_id, session_request(&backend))
        .unwrap();
    assert!(!std::sync::Arc::ptr_eq(&first, &second));
    assert_eq!(execute(&second, "execution-3", "isolated"), "turn:1");
}
