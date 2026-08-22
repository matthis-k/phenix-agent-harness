use phenix_conductor::ConductorRuntime;
use phenix_core::{
    AgentDefinition, BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy,
    CapabilitySet, ExecutionAuthority, ExecutionEventKind, ExecutionState, ExecutionTarget,
    ExecutionTerminationCause, InferenceOptions, ModelId, ModelTarget, ProviderId,
};
use serde_json::json;

fn fixed() -> ExecutionTarget {
    ExecutionTarget::Fixed(ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("mock").unwrap(),
        inference: InferenceOptions::default(),
    })
}

fn descriptor(id: &str) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind: CallableKind::Agent,
        description: id.to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

fn setup() -> (
    ConductorRuntime,
    phenix_core::ExecutionSummary,
    phenix_core::ExecutionSummary,
    phenix_core::ExecutionSummary,
) {
    let mut runtime = ConductorRuntime::new();
    let mut parent_authority = ExecutionAuthority::read_only();
    parent_authority
        .callables
        .insert(CallableId::parse("agent.child").unwrap());
    runtime
        .register_agent(AgentDefinition::new(
            descriptor("agent.parent"),
            parent_authority,
        ))
        .unwrap();
    runtime
        .register_agent(AgentDefinition::new(
            descriptor("agent.child"),
            ExecutionAuthority::read_only(),
        ))
        .unwrap();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();
    let parent = runtime
        .start_agent(
            &root.id,
            &CallableId::parse("agent.parent").unwrap(),
            "parent",
        )
        .unwrap();
    let child = runtime
        .start_agent(
            &parent.id,
            &CallableId::parse("agent.child").unwrap(),
            "child",
        )
        .unwrap();
    (runtime, root, parent, child)
}

#[test]
fn explicit_cancellation_records_requested_execution_for_the_subtree() {
    let (mut runtime, root, parent, child) = setup();
    runtime.cancel_execution(&parent.id).unwrap();

    let expected = ExecutionTerminationCause::ExplicitCancellation {
        requested_execution: parent.id.clone(),
    };
    for execution_id in [&parent.id, &child.id] {
        assert!(runtime.events_since(0).iter().any(|event| {
            &event.execution_id == execution_id
                && matches!(
                    &event.kind,
                    ExecutionEventKind::ExecutionTerminated { cause } if cause == &expected
                )
        }));
    }
    assert!(!runtime.events_since(0).iter().any(|event| {
        event.execution_id == root.id
            && matches!(event.kind, ExecutionEventKind::ExecutionTerminated { .. })
    }));
}

#[test]
fn ancestor_failure_records_the_failed_ancestor_and_replays_it() {
    let (mut runtime, root, parent, child) = setup();
    runtime
        .set_state(&parent.id, ExecutionState::Running)
        .unwrap();
    runtime
        .set_state(&child.id, ExecutionState::Running)
        .unwrap();
    runtime.set_state(&root.id, ExecutionState::Failed).unwrap();

    let expected = ExecutionTerminationCause::AncestorFailure {
        failed_ancestor: root.id.clone(),
    };
    for execution_id in [&parent.id, &child.id] {
        assert!(runtime.events_since(0).iter().any(|event| {
            &event.execution_id == execution_id
                && matches!(
                    &event.kind,
                    ExecutionEventKind::ExecutionTerminated { cause } if cause == &expected
                )
        }));
    }

    let restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();
    for execution_id in [&parent.id, &child.id] {
        assert!(restored.events_since(0).iter().any(|event| {
            &event.execution_id == execution_id
                && matches!(
                    &event.kind,
                    ExecutionEventKind::ExecutionTerminated { cause } if cause == &expected
                )
        }));
    }
}
