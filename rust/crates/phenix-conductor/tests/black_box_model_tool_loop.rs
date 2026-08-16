use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolHostingCapability, ToolInvocation,
};
use phenix_conductor::{ConductorError, ConductorRuntime};
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionTarget, InferenceOptions, ModelId, ModelTarget, ProviderId,
    RoutingProfileId,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

struct MockBackend {
    opened: Arc<AtomicBool>,
}
struct MockSession;

impl Backend for MockBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_hosting: ToolHostingCapability::Unsupported,
            images: false,
            persistent_sessions: false,
        }
    }
    fn open_session(
        &mut self,
        _request: BackendSessionRequest,
    ) -> Result<Box<dyn BackendSession>, BackendError> {
        self.opened.store(true, Ordering::SeqCst);
        Ok(Box::new(MockSession))
    }
}

impl BackendSession for MockSession {
    fn execute(
        &mut self,
        _request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        host.emit(BackendEvent::ReasoningDelta("think".to_owned()))?;
        host.emit(BackendEvent::ContentDelta("answer".to_owned()))?;
        Ok(())
    }
    fn cancel(&mut self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

struct ToolBackend {
    opened: Arc<AtomicBool>,
}
struct ToolSession;

impl Backend for ToolBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_hosting: ToolHostingCapability::Native,
            images: false,
            persistent_sessions: false,
        }
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Box<dyn BackendSession>, BackendError> {
        assert_eq!(request.tools.callables.len(), 1);
        assert_eq!(request.tools.callables[0].id.as_str(), "echo");
        self.opened.store(true, Ordering::SeqCst);
        Ok(Box::new(ToolSession))
    }
}

impl BackendSession for ToolSession {
    fn execute(
        &mut self,
        _request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        host.emit(BackendEvent::ReasoningDelta("before tool".to_owned()))?;
        let result = host.invoke_tool(ToolInvocation {
            callable: CallableId::parse("echo").unwrap(),
            arguments_json: r#"{"value":"hello"}"#.to_owned(),
        })?;
        assert!(result.success);
        assert_eq!(result.output, r#"{"value":"hello"}"#);
        host.emit(BackendEvent::ReasoningDelta("after tool".to_owned()))?;
        host.emit(BackendEvent::ContentDelta("done".to_owned()))?;
        Ok(())
    }

    fn cancel(&mut self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

struct UnsupportedBackend {
    opened: Arc<AtomicBool>,
}

impl Backend for UnsupportedBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_hosting: ToolHostingCapability::Unsupported,
            images: false,
            persistent_sessions: false,
        }
    }

    fn open_session(
        &mut self,
        _request: BackendSessionRequest,
    ) -> Result<Box<dyn BackendSession>, BackendError> {
        self.opened.store(true, Ordering::SeqCst);
        Ok(Box::new(MockSession))
    }
}

fn fixed() -> ExecutionTarget {
    ExecutionTarget::Fixed(ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("model").unwrap(),
        inference: InferenceOptions::default(),
    })
}

fn echo_descriptor() -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse("echo").unwrap(),
        kind: CallableKind::Tool,
        description: "echo JSON arguments".to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

#[test]
fn mock_backend_preserves_mixed_event_order() {
    let opened = Arc::new(AtomicBool::new(false));
    let mut backend = MockBackend {
        opened: opened.clone(),
    };
    let mut runtime = ConductorRuntime::new();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let execution = runtime.submit(&session.id, "hello").unwrap();
    runtime
        .drive_execution(&execution.id, &mut backend)
        .unwrap();

    assert!(opened.load(Ordering::SeqCst));
    let events = runtime.events_since(0);
    let reasoning = events
        .iter()
        .position(|e| matches!(e.kind, ExecutionEventKind::ReasoningDelta { .. }))
        .unwrap();
    let content = events
        .iter()
        .position(|e| matches!(e.kind, ExecutionEventKind::AssistantContentDelta { .. }))
        .unwrap();
    assert!(reasoning < content);
    assert!(events
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
}

#[test]
fn routed_execution_fails_before_backend_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let mut backend = MockBackend {
        opened: opened.clone(),
    };
    let mut runtime = ConductorRuntime::new();
    let session = runtime
        .create_session(
            None,
            None,
            ExecutionTarget::Routed(RoutingProfileId::parse("default").unwrap()),
        )
        .unwrap();
    let execution = runtime.submit(&session.id, "hello").unwrap();

    assert_eq!(
        runtime.drive_execution(&execution.id, &mut backend),
        Err(ConductorError::RoutingUnavailable)
    );
    assert!(!opened.load(Ordering::SeqCst));
}

#[test]
fn conductor_provisions_and_executes_tools_without_child_execution() {
    let opened = Arc::new(AtomicBool::new(false));
    let invoked = Arc::new(AtomicBool::new(false));
    let marker = invoked.clone();
    let mut backend = ToolBackend {
        opened: opened.clone(),
    };
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_tool(echo_descriptor(), move |arguments| {
            marker.store(true, Ordering::SeqCst);
            Ok(arguments.to_owned())
        })
        .unwrap();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let execution = runtime.submit(&session.id, "use echo").unwrap();

    runtime
        .drive_execution(&execution.id, &mut backend)
        .unwrap();

    assert!(opened.load(Ordering::SeqCst));
    assert!(invoked.load(Ordering::SeqCst));
    assert_eq!(runtime.snapshot().executions.len(), 1);

    let events = runtime.events_since(0);
    let before = events
        .iter()
        .position(|event| {
            matches!(
                event.kind,
                ExecutionEventKind::ReasoningDelta { ref text } if text == "before tool"
            )
        })
        .unwrap();
    let started = events
        .iter()
        .position(|event| matches!(event.kind, ExecutionEventKind::ToolCallStarted { .. }))
        .unwrap();
    let arguments = events
        .iter()
        .position(|event| matches!(event.kind, ExecutionEventKind::ToolCallArguments { .. }))
        .unwrap();
    let finished = events
        .iter()
        .position(|event| {
            matches!(
                event.kind,
                ExecutionEventKind::ToolCallFinished { success: true, .. }
            )
        })
        .unwrap();
    let after = events
        .iter()
        .position(|event| {
            matches!(
                event.kind,
                ExecutionEventKind::ReasoningDelta { ref text } if text == "after tool"
            )
        })
        .unwrap();

    assert!(before < started && started < arguments && arguments < finished && finished < after);
}

#[test]
fn required_tools_are_rejected_before_opening_unsupported_backend() {
    let opened = Arc::new(AtomicBool::new(false));
    let mut backend = UnsupportedBackend {
        opened: opened.clone(),
    };
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_tool(echo_descriptor(), |arguments| Ok(arguments.to_owned()))
        .unwrap();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let execution = runtime.submit(&session.id, "use echo").unwrap();

    assert!(matches!(
        runtime.drive_execution(&execution.id, &mut backend),
        Err(ConductorError::Backend(BackendError::Unsupported(_)))
    ));
    assert!(!opened.load(Ordering::SeqCst));
}
