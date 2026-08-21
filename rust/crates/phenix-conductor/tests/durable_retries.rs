use phenix_conductor::{ConductorError, ConductorRuntime, DomainEvent};
use phenix_core::{
    AgentDefinition, AttemptFailureReport, BackendId, CallableDescriptor, CallableId, CallableKind,
    CallablePolicy, CapabilitySet, ExecutionAuthority, ExecutionState, ExecutionTarget,
    InferenceOptions, ModelId, ModelTarget, ProviderId,
};
use serde_json::json;

fn fixed() -> ExecutionTarget {
    ExecutionTarget::Fixed(ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("model").unwrap(),
        inference: InferenceOptions::default(),
    })
}

fn agent() -> AgentDefinition {
    AgentDefinition::new(
        CallableDescriptor {
            id: CallableId::parse("agent.worker").unwrap(),
            kind: CallableKind::Agent,
            description: "worker".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        },
        ExecutionAuthority::read_only(),
    )
}

fn failure(approach: &str, failure_at: &str, reason: &str) -> AttemptFailureReport {
    AttemptFailureReport {
        approach: approach.to_owned(),
        failure_at: failure_at.to_owned(),
        reason: reason.to_owned(),
        completed_work: vec!["keep the validated parser".to_owned()],
    }
}

fn failed_child(
    runtime: &mut ConductorRuntime,
) -> (phenix_core::ExecutionSummary, phenix_core::ExecutionSummary) {
    runtime.register_agent(agent()).unwrap();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let root = runtime.submit(&session.id, "root objective").unwrap();
    let child = runtime
        .start_agent(
            &root.id,
            &CallableId::parse("agent.worker").unwrap(),
            "implement durable retries",
        )
        .unwrap();
    runtime
        .set_state(&child.id, ExecutionState::Failed)
        .unwrap();
    (root, child)
}

#[test]
fn retry_creates_fresh_execution_with_compact_failure_context() {
    let mut runtime = ConductorRuntime::new();
    let (_root, first) = failed_child(&mut runtime);
    let second = runtime
        .retry_agent(
            &first.id,
            failure(
                "reuse the old execution",
                "dispatch",
                "identity was not fresh",
            ),
        )
        .unwrap();

    assert_ne!(first.id, second.id);
    let group = runtime.attempt_group_for_execution(&second.id).unwrap();
    assert_eq!(group.id.as_str(), "attempt-group-1");
    assert_eq!(group.goal, "implement durable retries");
    assert_eq!(group.attempts, vec![first.id.clone(), second.id.clone()]);
    assert_eq!(group.failures.len(), 1);
    assert_eq!(group.failures[0].attempt, 1);

    let resolved = runtime.resolve_invocation(&second.id).unwrap();
    assert!(resolved.prompt.contains("implement durable retries"));
    assert!(resolved.prompt.contains("identity was not fresh"));
    assert!(resolved.prompt.contains("keep the validated parser"));

    runtime
        .set_state(&second.id, ExecutionState::Failed)
        .unwrap();
    let third = runtime
        .retry_agent(
            &second.id,
            failure("new execution", "verification", "missing replay coverage"),
        )
        .unwrap();
    let group = runtime.attempt_group_for_execution(&third.id).unwrap();
    assert_eq!(group.attempts.len(), 3);
    assert_eq!(group.failures.len(), 2);
    assert_eq!(group.failures[1].attempt, 2);
    assert_eq!(group.next_attempt(), 4);
}

#[test]
fn attempt_groups_replay_and_continue_their_identity_cursor() {
    let mut runtime = ConductorRuntime::new();
    let (root, first) = failed_child(&mut runtime);
    let _retry = runtime
        .retry_agent(&first.id, failure("first", "step one", "failed"))
        .unwrap();
    let expected = runtime.attempt_groups();

    let mut restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();
    assert_eq!(restored.attempt_groups(), expected);
    restored.register_agent(agent()).unwrap();
    let another = restored
        .start_agent(
            &root.id,
            &CallableId::parse("agent.worker").unwrap(),
            "another independent goal",
        )
        .unwrap();
    restored
        .set_state(&another.id, ExecutionState::Failed)
        .unwrap();
    let next = restored
        .retry_agent(&another.id, failure("second", "step two", "failed again"))
        .unwrap();
    assert_eq!(
        restored
            .attempt_group_for_execution(&next.id)
            .unwrap()
            .id
            .as_str(),
        "attempt-group-2"
    );
}

#[test]
fn retry_rejects_non_failed_and_superseded_attempts() {
    let mut runtime = ConductorRuntime::new();
    runtime.register_agent(agent()).unwrap();
    let session = runtime.create_session(None, None, fixed()).unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();
    let child = runtime
        .start_agent(
            &root.id,
            &CallableId::parse("agent.worker").unwrap(),
            "goal",
        )
        .unwrap();
    assert!(matches!(
        runtime.retry_agent(&child.id, failure("a", "b", "c")),
        Err(ConductorError::InvalidRetry(id)) if id == child.id
    ));

    runtime
        .set_state(&child.id, ExecutionState::Failed)
        .unwrap();
    let retry = runtime
        .retry_agent(&child.id, failure("a", "b", "c"))
        .unwrap();
    assert!(matches!(
        runtime.retry_agent(&child.id, failure("again", "old", "stale")),
        Err(ConductorError::InvalidRetry(id)) if id == child.id
    ));
    assert_ne!(retry.id, child.id);
}

#[test]
fn replay_rejects_retry_event_bound_to_the_wrong_execution() {
    let mut runtime = ConductorRuntime::new();
    let (_root, first) = failed_child(&mut runtime);
    runtime
        .retry_agent(&first.id, failure("a", "b", "c"))
        .unwrap();
    let mut journal = runtime.journal().clone();
    let event = journal
        .entries
        .iter_mut()
        .find_map(|entry| match &mut entry.event {
            DomainEvent::AttemptRetryStarted { execution_id, .. } => Some(execution_id),
            _ => None,
        })
        .unwrap();
    *event = first.id;

    assert!(ConductorRuntime::restore(journal).is_err());
}
