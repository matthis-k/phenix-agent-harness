use phenix_conductor::{
    CallableOperation, ConductorError, ConductorRuntime, ExecutionProvider, ExecutionProviderError,
    ExecutionProviderEvent, ExecutionProviderHost, ExecutionProviderKind, ExecutionProviderRequest,
    InvocationGuard, InvocationPolicyContext, InvocationSubject, PolicyDenial,
};
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId,
    ModelTarget, OrchestrationDefinition, OrchestrationNode, OrchestrationNodeId, ProviderId,
};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

#[derive(Clone)]
enum ProviderScript {
    Emit,
    Fail,
}

#[derive(Default)]
struct ProviderState {
    executed: AtomicUsize,
    requests: Mutex<Vec<ExecutionProviderRequest>>,
}

#[derive(Clone)]
struct MockProvider {
    state: Arc<ProviderState>,
    script: ProviderScript,
}

impl MockProvider {
    fn emitting(state: Arc<ProviderState>) -> Self {
        Self {
            state,
            script: ProviderScript::Emit,
        }
    }

    fn failing(state: Arc<ProviderState>) -> Self {
        Self {
            state,
            script: ProviderScript::Fail,
        }
    }
}

impl ExecutionProvider for MockProvider {
    fn kind(&self) -> ExecutionProviderKind {
        ExecutionProviderKind::Native
    }

    fn execute(
        &self,
        request: &ExecutionProviderRequest,
        host: &mut dyn ExecutionProviderHost,
    ) -> Result<(), ExecutionProviderError> {
        self.state.executed.fetch_add(1, Ordering::SeqCst);
        self.state.requests.lock().unwrap().push(request.clone());
        match &self.script {
            ProviderScript::Emit => {
                host.emit(ExecutionProviderEvent::ReasoningDelta(
                    "provider reasoning".to_owned(),
                ))?;
                host.emit(ExecutionProviderEvent::ContentDelta(
                    "provider result".to_owned(),
                ))?;
                Ok(())
            }
            ProviderScript::Fail => Err(ExecutionProviderError::Failed(
                "scripted provider failure".to_owned(),
            )),
        }
    }
}

fn model_target() -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("root").unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind,
        description: "provider runtime fixture".to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

fn node(id: &str, callable: CallableId, objective: Option<&str>) -> OrchestrationNode {
    OrchestrationNode {
        id: OrchestrationNodeId::parse(id).unwrap(),
        callable,
        depends_on: Vec::new(),
        objective: objective.map(str::to_owned),
    }
}

fn root(runtime: &mut ConductorRuntime) -> phenix_core::ExecutionSummary {
    let session = runtime
        .create_session(None, None, ExecutionTarget::Fixed(model_target()))
        .unwrap();
    runtime.submit(&session.id, "root input").unwrap()
}

#[test]
fn provider_backed_agent_is_not_reinterpreted_as_model_execution() {
    let state = Arc::new(ProviderState::default());
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_provider_agent(
            phenix_core::AgentDefinition::new(
                descriptor("agent.native", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ),
            MockProvider::emitting(state),
        )
        .unwrap();
    let root = root(&mut runtime);
    let child = runtime
        .start_agent(
            &root.id,
            &CallableId::parse("agent.native").unwrap(),
            "native objective",
        )
        .unwrap();

    assert_eq!(
        runtime.execution_provider_kind(&child.id).unwrap(),
        ExecutionProviderKind::Native
    );
    assert!(matches!(
        runtime.resolve_invocation(&child.id),
        Err(ConductorError::NonModelExecution(id)) if id == child.id
    ));
}

#[test]
fn mock_provider_executes_an_ordinary_child_and_emits_canonical_events() {
    let state = Arc::new(ProviderState::default());
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_provider_agent(
            phenix_core::AgentDefinition::new(
                descriptor("agent.native", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ),
            MockProvider::emitting(state.clone()),
        )
        .unwrap();
    let root = root(&mut runtime);
    let callable = CallableId::parse("agent.native").unwrap();
    let child = runtime
        .start_agent(&root.id, &callable, "native objective")
        .unwrap();

    runtime.drive_provider_execution(&child.id).unwrap();

    assert_eq!(state.executed.load(Ordering::SeqCst), 1);
    let requests = state.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].execution_id, child.id);
    assert_eq!(requests[0].parent_execution.as_ref(), Some(&root.id));
    assert_eq!(requests[0].callable, callable);
    assert_eq!(requests[0].objective, "native objective");
    assert_eq!(requests[0].config_revision.as_str(), "config-1");
    drop(requests);

    let snapshot = runtime.snapshot();
    let child_after = snapshot
        .executions
        .iter()
        .find(|execution| execution.id == child.id)
        .unwrap();
    assert_eq!(child_after.kind, ExecutionKind::Agent);
    assert_eq!(child_after.state, ExecutionState::Completed);

    let events = runtime.events_since(0);
    let reasoning = events
        .iter()
        .position(|event| {
            event.execution_id == child.id
                && matches!(
                    &event.kind,
                    ExecutionEventKind::ReasoningDelta { text }
                        if text == "provider reasoning"
                )
        })
        .unwrap();
    let content = events
        .iter()
        .position(|event| {
            event.execution_id == child.id
                && matches!(
                    &event.kind,
                    ExecutionEventKind::AssistantContentDelta { text }
                        if text == "provider result"
                )
        })
        .unwrap();
    assert!(reasoning < content);
}

#[test]
fn workflow_step_is_provider_agnostic_and_completes_normally() {
    let state = Arc::new(ProviderState::default());
    let mut runtime = ConductorRuntime::new();
    let step = CallableId::parse("agent.native").unwrap();
    runtime
        .register_provider_agent(
            phenix_core::AgentDefinition::new(
                descriptor("agent.native", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ),
            MockProvider::emitting(state.clone()),
        )
        .unwrap();
    runtime
        .register_orchestration(OrchestrationDefinition {
            interface_agent: None,
            descriptor: descriptor("orchestration.native", CallableKind::Orchestration),
            nodes: vec![node("provider", step, Some("provider step"))],
        })
        .unwrap();
    let root = root(&mut runtime);
    let orchestration = runtime
        .start_orchestration(
            &root.id,
            &CallableId::parse("orchestration.native").unwrap(),
            "orchestration objective",
        )
        .unwrap();
    let child = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
        .unwrap();

    assert_eq!(
        runtime.execution_provider_kind(&child.id).unwrap(),
        ExecutionProviderKind::Native
    );
    runtime.drive_provider_execution(&child.id).unwrap();

    let snapshot = runtime.snapshot();
    assert_eq!(
        snapshot
            .executions
            .iter()
            .find(|execution| execution.id == orchestration.id)
            .unwrap()
            .state,
        ExecutionState::Completed
    );
    assert_eq!(state.executed.load(Ordering::SeqCst), 1);
}

#[test]
fn provider_failure_uses_the_normal_child_and_workflow_failure_lifecycle() {
    let state = Arc::new(ProviderState::default());
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_provider_agent(
            phenix_core::AgentDefinition::new(
                descriptor("agent.native", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ),
            MockProvider::failing(state.clone()),
        )
        .unwrap();
    runtime
        .register_orchestration(OrchestrationDefinition {
            interface_agent: None,
            descriptor: descriptor("orchestration.native", CallableKind::Orchestration),
            nodes: vec![node(
                "provider",
                CallableId::parse("agent.native").unwrap(),
                None,
            )],
        })
        .unwrap();
    let root = root(&mut runtime);
    let orchestration = runtime
        .start_orchestration(
            &root.id,
            &CallableId::parse("orchestration.native").unwrap(),
            "orchestration objective",
        )
        .unwrap();
    let child = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
        .unwrap();

    assert!(matches!(
        runtime.drive_provider_execution(&child.id),
        Err(ConductorError::ExecutionProvider(ExecutionProviderError::Failed(message)))
            if message == "scripted provider failure"
    ));

    let snapshot = runtime.snapshot();
    assert_eq!(
        snapshot
            .executions
            .iter()
            .find(|execution| execution.id == child.id)
            .unwrap()
            .state,
        ExecutionState::Failed
    );
    assert_eq!(
        snapshot
            .executions
            .iter()
            .find(|execution| execution.id == orchestration.id)
            .unwrap()
            .state,
        ExecutionState::Failed
    );
    assert_eq!(state.executed.load(Ordering::SeqCst), 1);
}

struct DenyProviderDispatch;

impl InvocationGuard for DenyProviderDispatch {
    fn check(&self, context: &InvocationPolicyContext<'_>) -> Result<(), PolicyDenial> {
        match &context.subject {
            InvocationSubject::Callable {
                operation: CallableOperation::DispatchProvider,
                ..
            } => Err(PolicyDenial::new(
                "provider_denied",
                "provider dispatch denied",
            )),
            _ => Ok(()),
        }
    }
}

#[test]
fn policy_runs_before_provider_code_and_leaves_no_execution_side_effect() {
    let state = Arc::new(ProviderState::default());
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_provider_agent(
            phenix_core::AgentDefinition::new(
                descriptor("agent.native", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ),
            MockProvider::emitting(state.clone()),
        )
        .unwrap();
    runtime.register_invocation_guard(DenyProviderDispatch);
    let root = root(&mut runtime);
    let child = runtime
        .start_agent(
            &root.id,
            &CallableId::parse("agent.native").unwrap(),
            "native objective",
        )
        .unwrap();
    let before_events = runtime.events_since(0).len();

    assert!(matches!(
        runtime.drive_provider_execution(&child.id),
        Err(ConductorError::PolicyDenied { ref denial, .. })
            if denial.code == "provider_denied"
    ));

    assert_eq!(state.executed.load(Ordering::SeqCst), 0);
    assert_eq!(runtime.events_since(0).len(), before_events);
    assert_eq!(
        runtime
            .snapshot()
            .executions
            .iter()
            .find(|execution| execution.id == child.id)
            .unwrap()
            .state,
        ExecutionState::Pending
    );
}

#[test]
fn cancelled_provider_child_cannot_be_dispatched_after_cancellation() {
    let state = Arc::new(ProviderState::default());
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_provider_agent(
            phenix_core::AgentDefinition::new(
                descriptor("agent.native", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ),
            MockProvider::emitting(state.clone()),
        )
        .unwrap();
    let root = root(&mut runtime);
    let child = runtime
        .start_agent(
            &root.id,
            &CallableId::parse("agent.native").unwrap(),
            "native objective",
        )
        .unwrap();
    runtime.cancel_execution(&child.id).unwrap();

    assert!(matches!(
        runtime.drive_provider_execution(&child.id),
        Err(ConductorError::InvalidLifecycle(id)) if id == child.id
    ));
    assert_eq!(state.executed.load(Ordering::SeqCst), 0);
}
