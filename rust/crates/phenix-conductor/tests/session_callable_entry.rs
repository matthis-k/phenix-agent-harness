use phenix_conductor::ConductorRuntime;
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
    ProviderId,
};
use serde_json::json;

fn fixed_target() -> ExecutionTarget {
    ExecutionTarget::Fixed(ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("model").unwrap(),
        inference: InferenceOptions::default(),
    })
}

fn agent(id: &str) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind: CallableKind::Agent,
        description: "public callable entrypoint fixture".to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

#[test]
fn frontend_layer_can_start_a_registered_top_level_callable_without_a_wrapper_execution() {
    let mut runtime = ConductorRuntime::new();
    runtime.register_agent(agent("scout")).unwrap();
    let session = runtime.create_session(None, None, fixed_target()).unwrap();

    let execution = runtime
        .start_session_callable(
            &session.id,
            &CallableId::parse("scout").unwrap(),
            "inspect the repository",
        )
        .unwrap();

    assert_eq!(execution.session_id, session.id);
    assert_eq!(execution.parent_execution, None);
    assert_eq!(execution.kind, ExecutionKind::Agent);
    assert_eq!(execution.state, ExecutionState::Pending);
    assert_eq!(runtime.snapshot().executions, vec![execution]);
}

#[test]
fn rejected_top_level_callable_does_not_create_durable_execution_state() {
    let mut runtime = ConductorRuntime::new();
    let session = runtime.create_session(None, None, fixed_target()).unwrap();

    let result = runtime.start_session_callable(
        &session.id,
        &CallableId::parse("missing").unwrap(),
        "inspect the repository",
    );

    assert!(result.is_err());
    assert!(runtime.snapshot().executions.is_empty());
}
