use phenix_conductor::ConductorRuntime;
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
    OrchestrationDefinition, OrchestrationNode, OrchestrationNodeId, ProviderId,
};
use serde_json::json;

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

fn node(id: &str, callable: &str, depends_on: &[&str]) -> OrchestrationNode {
    OrchestrationNode {
        id: OrchestrationNodeId::parse(id).unwrap(),
        callable: CallableId::parse(callable).unwrap(),
        depends_on: depends_on
            .iter()
            .map(|dependency| OrchestrationNodeId::parse(*dependency).unwrap())
            .collect(),
        objective: None,
    }
}

fn target() -> ExecutionTarget {
    ExecutionTarget::Fixed(ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("model").unwrap(),
        inference: InferenceOptions::default(),
    })
}

fn child_states(
    runtime: &ConductorRuntime,
    orchestration: &phenix_core::ExecutionId,
) -> Vec<(String, ExecutionState)> {
    let mut children = runtime
        .snapshot()
        .executions
        .into_iter()
        .filter(|execution| execution.parent_execution.as_ref() == Some(orchestration))
        .filter(|execution| execution.kind == ExecutionKind::Agent)
        .map(|execution| {
            (
                execution
                    .callable
                    .expect("agent child has callable")
                    .to_string(),
                execution.state,
            )
        })
        .collect::<Vec<_>>();
    children.sort_by(|left, right| left.0.cmp(&right.0));
    children
}

#[test]
fn dag_runtime_starts_all_ready_nodes_and_waits_for_join_dependencies() {
    let mut runtime = ConductorRuntime::new();
    for id in ["agent.alpha", "agent.beta", "agent.join"] {
        runtime
            .register_agent(descriptor(id, CallableKind::Agent))
            .unwrap();
    }
    runtime
        .register_orchestration(OrchestrationDefinition {
            descriptor: descriptor("orchestration.parallel", CallableKind::Orchestration),
            nodes: vec![
                node("alpha", "agent.alpha", &[]),
                node("beta", "agent.beta", &[]),
                node("join", "agent.join", &["alpha", "beta"]),
            ],
        })
        .unwrap();

    let session = runtime.create_session(None, None, target()).unwrap();
    let root = runtime.submit(&session.id, "run the DAG").unwrap();
    let orchestration = runtime
        .start_orchestration(
            &root.id,
            &CallableId::parse("orchestration.parallel").unwrap(),
            "parallel work",
        )
        .unwrap();

    assert_eq!(
        child_states(&runtime, &orchestration.id),
        vec![
            ("agent.alpha".to_owned(), ExecutionState::Pending),
            ("agent.beta".to_owned(), ExecutionState::Pending),
        ],
        "all dependency-free nodes must become runnable together"
    );

    let alpha = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&orchestration.id)
                && execution
                    .callable
                    .as_ref()
                    .is_some_and(|id| id.as_str() == "agent.alpha")
        })
        .unwrap();
    runtime
        .set_state(&alpha.id, ExecutionState::Completed)
        .unwrap();

    assert_eq!(
        child_states(&runtime, &orchestration.id),
        vec![
            ("agent.alpha".to_owned(), ExecutionState::Completed),
            ("agent.beta".to_owned(), ExecutionState::Pending),
        ],
        "join must stay blocked while one dependency is unfinished"
    );

    let beta = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&orchestration.id)
                && execution
                    .callable
                    .as_ref()
                    .is_some_and(|id| id.as_str() == "agent.beta")
        })
        .unwrap();
    runtime
        .set_state(&beta.id, ExecutionState::Completed)
        .unwrap();

    assert_eq!(
        child_states(&runtime, &orchestration.id),
        vec![
            ("agent.alpha".to_owned(), ExecutionState::Completed),
            ("agent.beta".to_owned(), ExecutionState::Completed),
            ("agent.join".to_owned(), ExecutionState::Pending),
        ],
        "join becomes runnable only after every declared dependency completes"
    );
}
