use phenix_backend::{
    Backend, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSessionRequest, ToolInvocation, ToolProvision, ToolResult,
};
use phenix_backend_acp::{AcpBackend, AcpBackendConfig};
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionId, InferenceOptions, ModelId, ModelTarget, ProviderId,
};
use serde_json::json;

#[derive(Default)]
struct ToolHost {
    content: String,
    invocations: Vec<ToolInvocation>,
}

impl BackendHost for ToolHost {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError> {
        if let BackendEvent::ContentDelta(text) = event {
            self.content.push_str(&text);
        }
        Ok(())
    }

    fn invoke_tool(&mut self, invocation: ToolInvocation) -> Result<ToolResult, BackendError> {
        let arguments: serde_json::Value = serde_json::from_str(&invocation.arguments_json)
            .map_err(|error| BackendError::Protocol(error.to_string()))?;
        let value = arguments
            .get("value")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| BackendError::Protocol("echo value is missing".to_owned()))?;
        let output = format!("echo:{value}");
        self.invocations.push(invocation);
        Ok(ToolResult {
            output,
            success: true,
        })
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

fn callable() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse("phenix.echo").unwrap(),
        kind: CallableKind::Tool,
        description: "Echo the supplied value".to_owned(),
        input_schema: json!({
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"]
        }),
        output_schema: json!({"type": "string"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

#[test]
fn real_acp_agent_calls_conductor_tool_and_continues_model_turn() {
    let fixture = env!("CARGO_BIN_EXE_acp-tool-bridge-fixture");
    let cwd = std::env::current_dir().unwrap();
    let mut backend = AcpBackend::new(AcpBackendConfig::new(
        BackendId::parse("fixture-acp").unwrap(),
        ProviderId::parse("fixture-provider").unwrap(),
        fixture,
        cwd,
    ));
    let tools = ToolProvision {
        callables: vec![callable()],
    }
    .prepare(&backend.capabilities())
    .unwrap();
    let session = backend
        .open_session(BackendSessionRequest {
            model: target(),
            tools,
        })
        .unwrap();
    let mut host = ToolHost::default();

    session
        .execute(
            BackendExecutionRequest {
                execution_id: ExecutionId::parse("tool-execution").unwrap(),
                prompt: "use the echo tool".to_owned(),
            },
            &mut host,
        )
        .unwrap();

    assert_eq!(host.invocations.len(), 1);
    assert_eq!(host.invocations[0].callable.as_str(), "phenix.echo");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&host.invocations[0].arguments_json).unwrap(),
        json!({"value": "from-acp"})
    );
    assert_eq!(host.content, "continued:echo:from-acp");
}
