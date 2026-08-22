use phenix_conductor::{
    ConductorError, ConductorRuntime, DomainEvent, OrchestrationFailureDecisionRequest,
};
use phenix_core::{
    AgentDefinition, BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy,
    CapabilitySet, ExecutionAuthority, ExecutionId, ExecutionKind, ExecutionState, ExecutionTarget,
    InferenceOptions, ModelId, ModelTarget, OrchestrationDefinition, OrchestrationFailureDecision,
    OrchestrationNode, OrchestrationNodeId, ProviderId,
};
use serde_json::json;
use std::collections::BTreeSet;

fn fixed() -> ExecutionTarget {
    ExecutionTarget::Fixed(ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("model").unwrap(),
        inference: InferenceOptions::default(),
    })
}

fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind,
        description: id.to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

fn agent(id: &str, callables: &[&str]) -> AgentDefinition {
    let mut authority = ExecutionAuthority::read_only();
    authority.callables = callables
        .iter()
        .map(|id| CallableId::parse(*id).unwrap())
        .collect::<BTreeSet<_>>();
    AgentDefinition::new(descriptor(id, CallableKind::Agent), authority)
}

fn node(id: &str, callable: &str, depends_on: &[&str]) -> OrchestrationNode {
    OrchestrationNode {
        id: OrchestrationNodeId::parse(id).unwrap(),
        callable: CallableId::parse(callable).unwrap(),
        depends_on: depends_on
            .iter()
            .map(|id| OrchestrationNodeId::parse(*id).unwrap())
            .collect(),
        objective: Some(format!("run {id}")),
    }
}

fn register(runtime: &mut ConductorRuntime, interface: bool) {
    runtime
        .register_agent(agent("agent.primary", &["agent.alternate"]))
        .unwrap();
    runtime
        .register_agent(agent("agent.alternate", &[]))
        .unwrap();
    runtime
        .register_agent(agent(
            "agent.interface",
            &["agent.primary", "agent.alternate"],
        ))
        .unwrap();
    runtime.register_agent(agent("agent.after", &[])).unwrap();
    runtime
        .register_orchestration(OrchestrationDefinition {
            descriptor: descriptor("orchestration.test", CallableKind::Orchestration),
            interface_agent: interface.then(|| CallableId::parse("agent.interface").unwrap()),
            nodes: vec![
                node("primary", "agent.primary", &[]),
                node("after", "agent.after", &["primary"]),
            ],
        })
        .unwrap();
}

fn setup(
    interface: bool,
) -> (
    ConductorRuntime,
    phenix_core::ExecutionSummary,
    phenix_core::ExecutionSummary,
) {
    let mut runtime = ConductorRuntime::new();
    register(&mut runtime, interface);
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();
    let orchestration = runtime
        .start_orchestration(
            &root.id,
            &CallableId::parse("orchestration.test").unwrap(),
            "recover safely",
        )
        .unwrap();
    let first = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&orchestration.id)
                && execution
                    .callable
                    .as_ref()
                    .is_some_and(|id| id.as_str() == "agent.primary")
        })
        .unwrap();
    (runtime, orchestration, first)
}

fn fail_and_start_interface(
    runtime: &mut ConductorRuntime,
    orchestration: &ExecutionId,
    failed: &ExecutionId,
) -> phenix_core::ExecutionSummary {
    runtime.set_state(failed, ExecutionState::Failed).unwrap();
    let interface = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(orchestration)
                && execution
                    .callable
                    .as_ref()
                    .is_some_and(|id| id.as_str() == "agent.interface")
        })
        .expect("failure starts the configured interface agent");
    runtime
        .set_state(&interface.id, ExecutionState::Running)
        .unwrap();
    interface
}

#[test]
fn deterministic_orchestration_records_fail_before_failing_parent() {
    let (mut runtime, orchestration, first) = setup(false);
    runtime
        .set_state(&first.id, ExecutionState::Failed)
        .unwrap();

    let parent = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| execution.id == orchestration.id)
        .unwrap();
    assert_eq!(parent.state, ExecutionState::Failed);
    let decision = runtime
        .orchestration_failure_decision(&first.id)
        .expect("deterministic failure decision is durable");
    assert_eq!(decision.decider_execution, None);
    assert_eq!(decision.decision, OrchestrationFailureDecision::Fail);

    let decision_index = runtime
        .journal()
        .entries
        .iter()
        .position(|entry| {
            matches!(
                &entry.event,
                DomainEvent::OrchestrationDecisionMade { decision }
                    if decision.failed_child == first.id
            )
        })
        .unwrap();
    let parent_failed_index = runtime
        .journal()
        .entries
        .iter()
        .position(|entry| {
            matches!(
                &entry.event,
                DomainEvent::ExecutionStateChanged { execution_id, state }
                    if execution_id == &orchestration.id && state == &ExecutionState::Failed
            )
        })
        .unwrap();
    assert!(decision_index < parent_failed_index);
}

#[test]
fn retry_is_one_durable_decision_with_runtime_owned_failure_context() {
    let (mut runtime, orchestration, first) = setup(true);
    let interface = fail_and_start_interface(&mut runtime, &orchestration.id, &first.id);
    let retry = runtime
        .decide_orchestration_failure(&interface.id, OrchestrationFailureDecisionRequest::Retry)
        .unwrap()
        .unwrap();

    assert_ne!(retry.id, first.id);
    let group = runtime.attempt_group_for_execution(&retry.id).unwrap();
    assert_eq!(group.attempts, vec![first.id.clone(), retry.id.clone()]);
    assert_eq!(group.failures.len(), 1);
    assert_eq!(group.failures[0].reason, "execution failed");
    assert!(group.failures[0].completed_work.is_empty());
    assert_eq!(
        runtime
            .orchestration_failure_decision(&first.id)
            .unwrap()
            .decision,
        OrchestrationFailureDecision::Retry {
            execution_id: retry.id.clone()
        }
    );
    assert!(matches!(
        runtime.decide_orchestration_failure(
            &interface.id,
            OrchestrationFailureDecisionRequest::Continue,
        ),
        Err(ConductorError::InvalidFailureDecision { .. })
    ));
}

#[test]
fn replacement_obeys_interface_delegation_and_unblocks_the_original_node() {
    let (mut runtime, orchestration, first) = setup(true);
    let interface = fail_and_start_interface(&mut runtime, &orchestration.id, &first.id);
    let replacement = runtime
        .decide_orchestration_failure(
            &interface.id,
            OrchestrationFailureDecisionRequest::ChooseAnotherChild {
                callable: CallableId::parse("agent.alternate").unwrap(),
                objective: "try the bounded alternate".to_owned(),
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(
        replacement.callable.as_ref().unwrap().as_str(),
        "agent.alternate"
    );
    runtime
        .set_state(&replacement.id, ExecutionState::Completed)
        .unwrap();

    assert!(runtime.snapshot().executions.into_iter().any(|execution| {
        execution.parent_execution.as_ref() == Some(&orchestration.id)
            && execution
                .callable
                .as_ref()
                .is_some_and(|id| id.as_str() == "agent.after")
            && execution.state == ExecutionState::Pending
    }));
}

#[test]
fn continue_marks_the_failed_node_handled() {
    let (mut runtime, orchestration, first) = setup(true);
    let interface = fail_and_start_interface(&mut runtime, &orchestration.id, &first.id);
    runtime
        .decide_orchestration_failure(&interface.id, OrchestrationFailureDecisionRequest::Continue)
        .unwrap();
    assert!(runtime.snapshot().executions.into_iter().any(|execution| {
        execution.parent_execution.as_ref() == Some(&orchestration.id)
            && execution
                .callable
                .as_ref()
                .is_some_and(|id| id.as_str() == "agent.after")
    }));
}

#[test]
fn interface_without_recovery_authority_cannot_choose_another_child() {
    let mut runtime = ConductorRuntime::new();
    runtime.register_agent(agent("agent.primary", &[])).unwrap();
    runtime
        .register_agent(agent("agent.alternate", &[]))
        .unwrap();
    runtime
        .register_agent(agent("agent.interface", &[]))
        .unwrap();
    runtime
        .register_orchestration(OrchestrationDefinition {
            descriptor: descriptor("orchestration.test", CallableKind::Orchestration),
            interface_agent: Some(CallableId::parse("agent.interface").unwrap()),
            nodes: vec![node("primary", "agent.primary", &[])],
        })
        .unwrap();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();
    let orchestration = runtime
        .start_orchestration(
            &root.id,
            &CallableId::parse("orchestration.test").unwrap(),
            "test delegation",
        )
        .unwrap();
    let first = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
        .unwrap();
    let interface = fail_and_start_interface(&mut runtime, &orchestration.id, &first.id);
    assert!(matches!(
        runtime.decide_orchestration_failure(
            &interface.id,
            OrchestrationFailureDecisionRequest::ChooseAnotherChild {
                callable: CallableId::parse("agent.alternate").unwrap(),
                objective: "not delegated".to_owned(),
            },
        ),
        Err(ConductorError::DelegationDenied { .. })
    ));
}

#[test]
fn failed_interface_records_fallback_decisions_and_fails_the_parent() {
    let (mut runtime, orchestration, first) = setup(true);
    runtime
        .set_state(&first.id, ExecutionState::Failed)
        .unwrap();
    let interface = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&orchestration.id)
                && execution
                    .callable
                    .as_ref()
                    .is_some_and(|id| id.as_str() == "agent.interface")
        })
        .unwrap();
    runtime
        .set_state(&interface.id, ExecutionState::Failed)
        .unwrap();
    assert_eq!(
        runtime
            .orchestration_failure_decision(&first.id)
            .unwrap()
            .decision,
        OrchestrationFailureDecision::Fail
    );
    assert_eq!(
        runtime
            .orchestration_failure_decision(&interface.id)
            .unwrap()
            .decision,
        OrchestrationFailureDecision::Fail
    );
    assert_eq!(
        runtime
            .snapshot()
            .executions
            .into_iter()
            .find(|execution| execution.id == orchestration.id)
            .unwrap()
            .state,
        ExecutionState::Failed
    );
}

#[test]
fn decisions_replay_and_reject_rebinding_the_recovery_execution() {
    let (mut runtime, orchestration, first) = setup(true);
    let interface = fail_and_start_interface(&mut runtime, &orchestration.id, &first.id);
    runtime
        .decide_orchestration_failure(&interface.id, OrchestrationFailureDecisionRequest::Retry)
        .unwrap();
    let expected = runtime.orchestration_failure_decisions();
    let restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();
    assert_eq!(restored.orchestration_failure_decisions(), expected);

    let mut journal = runtime.journal().clone();
    let decision = journal
        .entries
        .iter_mut()
        .find_map(|entry| match &mut entry.event {
            DomainEvent::OrchestrationDecisionMade { decision } => Some(decision),
            _ => None,
        })
        .unwrap();
    decision.decision = OrchestrationFailureDecision::Retry {
        execution_id: first.id,
    };
    assert!(ConductorRuntime::restore(journal).is_err());
}

#[test]
fn configured_interface_is_part_of_the_orchestration_delegation_ceiling() {
    let (mut runtime, orchestration, first) = setup(true);
    runtime
        .set_state(&first.id, ExecutionState::Failed)
        .unwrap();
    let interface = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&orchestration.id)
                && execution
                    .callable
                    .as_ref()
                    .is_some_and(|id| id.as_str() == "agent.interface")
        })
        .unwrap();
    assert_eq!(interface.kind, ExecutionKind::Agent);
}
