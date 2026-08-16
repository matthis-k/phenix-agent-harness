use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolInvocation, ToolPresentation,
};
use phenix_conductor::{ConductorError, ConductorRuntime};
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId,
    ModelTarget, ProviderId, RoutingProfile, RoutingProfileId, WorkflowDefinition,
    WorkflowExecutionPolicy, WorkflowStep,
};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

struct MockBackend {
    opened: Arc<AtomicBool>,
    expected_model: Option<String>,
}
struct MockSession;

impl Backend for MockBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::new(),
            images: false,
            persistent_sessions: false,
        }
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        if let Some(expected) = self.expected_model.as_deref() {
            assert_eq!(request.model.model.as_str(), expected);
        }
        self.opened.store(true, Ordering::SeqCst);
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

struct ToolBackend {
    opened: Arc<AtomicBool>,
}
struct ToolSession;

impl Backend for ToolBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::Native]),
            images: false,
            persistent_sessions: false,
        }
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        assert_eq!(request.tools.presentation(), Some(ToolPresentation::Native));
        assert_eq!(request.tools.callables().len(), 1);
        assert_eq!(request.tools.callables()[0].id.as_str(), "echo");
        self.opened.store(true, Ordering::SeqCst);
        Ok(Arc::new(ToolSession))
    }
}

impl BackendSession for ToolSession {
    fn execute(
        &self,
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

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

struct UnsupportedBackend {
    opened: Arc<AtomicBool>,
}

impl Backend for UnsupportedBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::new(),
            images: false,
            persistent_sessions: false,
        }
    }

    fn open_session(
        &mut self,
        _request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        self.opened.store(true, Ordering::SeqCst);
        Ok(Arc::new(MockSession))
    }
}

fn model(name: &str) -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse(name).unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn fixed() -> ExecutionTarget {
    ExecutionTarget::Fixed(model("model"))
}

fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind,
        description: "test callable".to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

fn echo_descriptor() -> CallableDescriptor {
    descriptor("echo", CallableKind::Tool)
}

#[test]
fn mock_backend_preserves_mixed_event_order() {
    let opened = Arc::new(AtomicBool::new(false));
    let mut backend = MockBackend {
        opened: opened.clone(),
        expected_model: None,
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
        .position(|event| matches!(event.kind, ExecutionEventKind::ReasoningDelta { .. }))
        .unwrap();
    let content = events
        .iter()
        .position(|event| matches!(event.kind, ExecutionEventKind::AssistantContentDelta { .. }))
        .unwrap();
    assert!(reasoning < content);
    assert!(events
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
}

#[test]
fn routed_execution_resolves_before_backend_open() {
    let opened = Arc::new(AtomicBool::new(false));
    let mut backend = MockBackend {
        opened: opened.clone(),
        expected_model: Some("routed-root".to_owned()),
    };
    let mut runtime = ConductorRuntime::new();
    let profile = RoutingProfileId::parse("default").unwrap();
    runtime
        .register_routing_profile(RoutingProfile {
            id: profile.clone(),
            default_target: model("routed-root"),
            callable_targets: BTreeMap::new(),
        })
        .unwrap();
    let session = runtime
        .create_session(None, None, ExecutionTarget::Routed(profile))
        .unwrap();
    let execution = runtime.submit(&session.id, "hello").unwrap();

    runtime
        .drive_execution(&execution.id, &mut backend)
        .unwrap();
    assert!(opened.load(Ordering::SeqCst));
}

#[test]
fn routed_agent_uses_callable_specific_model() {
    let mut runtime = ConductorRuntime::new();
    let scout = CallableId::parse("agent.scout").unwrap();
    runtime
        .register_agent(descriptor("agent.scout", CallableKind::Agent))
        .unwrap();
    let profile = RoutingProfileId::parse("default").unwrap();
    runtime
        .register_routing_profile(RoutingProfile {
            id: profile.clone(),
            default_target: model("root"),
            callable_targets: BTreeMap::from([(scout.clone(), model("scout"))]),
        })
        .unwrap();
    let session = runtime
        .create_session(None, None, ExecutionTarget::Routed(profile))
        .unwrap();
    let root = runtime.submit(&session.id, "work").unwrap();
    let child = runtime.start_agent(&root.id, &scout, "inspect").unwrap();

    assert_eq!(
        runtime.resolve_invocation(&root.id).unwrap().model,
        model("root")
    );
    assert_eq!(
        runtime.resolve_invocation(&child.id).unwrap().model,
        model("scout")
    );
}

#[test]
fn sequential_workflow_is_conductor_owned_and_advances_agent_children() {
    let mut runtime = ConductorRuntime::new();
    let scout = CallableId::parse("agent.scout").unwrap();
    let worker = CallableId::parse("agent.worker").unwrap();
    runtime
        .register_agent(descriptor("agent.scout", CallableKind::Agent))
        .unwrap();
    runtime
        .register_agent(descriptor("agent.worker", CallableKind::Agent))
        .unwrap();
    runtime
        .register_workflow(WorkflowDefinition {
            descriptor: descriptor("workflow.implement", CallableKind::Workflow),
            policy: WorkflowExecutionPolicy::Sequential,
            steps: vec![
                WorkflowStep {
                    callable: scout,
                    objective: Some("inspect".to_owned()),
                },
                WorkflowStep {
                    callable: worker,
                    objective: None,
                },
            ],
        })
        .unwrap();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();
    let workflow_id = CallableId::parse("workflow.implement").unwrap();
    let workflow = runtime
        .start_workflow(&root.id, &workflow_id, "implement")
        .unwrap();

    assert_eq!(workflow.state, ExecutionState::Running);
    assert!(matches!(
        runtime.resolve_invocation(&workflow.id),
        Err(ConductorError::NonModelExecution(_))
    ));

    let snapshot = runtime.snapshot();
    let first = snapshot
        .executions
        .iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&workflow.id)
                && execution.kind == ExecutionKind::Agent
        })
        .unwrap()
        .clone();
    assert_eq!(
        snapshot
            .executions
            .iter()
            .filter(|execution| execution.parent_execution.as_ref() == Some(&workflow.id))
            .count(),
        1
    );

    let mut backend = MockBackend {
        opened: Arc::new(AtomicBool::new(false)),
        expected_model: None,
    };
    runtime.drive_execution(&first.id, &mut backend).unwrap();

    let snapshot = runtime.snapshot();
    let second = snapshot
        .executions
        .iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&workflow.id)
                && execution.id != first.id
                && execution.state == ExecutionState::Pending
        })
        .unwrap()
        .clone();
    assert_eq!(
        snapshot
            .executions
            .iter()
            .filter(|execution| execution.parent_execution.as_ref() == Some(&workflow.id))
            .count(),
        2
    );

    runtime.drive_execution(&second.id, &mut backend).unwrap();
    let snapshot = runtime.snapshot();
    assert_eq!(
        snapshot
            .executions
            .iter()
            .find(|execution| execution.id == workflow.id)
            .unwrap()
            .state,
        ExecutionState::Completed
    );
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
