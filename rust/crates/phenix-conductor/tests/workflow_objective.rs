use phenix_conductor::ConductorRuntime;
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionTarget, InferenceOptions, ModelId, ModelTarget, ProviderId, WorkflowDefinition,
    WorkflowExecutionPolicy, WorkflowStep,
};
use serde_json::json;

fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind,
        description: "workflow objective fixture".to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

fn target() -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("mock").unwrap(),
        provider: ProviderId::parse("mock").unwrap(),
        model: ModelId::parse("mock-model").unwrap(),
        inference: InferenceOptions::default(),
    }
}

#[test]
fn guided_workflow_step_keeps_the_user_objective() {
    let agent = CallableId::parse("agent.worker").unwrap();
    let workflow = CallableId::parse("workflow.implement").unwrap();
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_agent(descriptor(agent.as_str(), CallableKind::Agent))
        .unwrap();
    runtime
        .register_workflow(WorkflowDefinition {
            descriptor: descriptor(workflow.as_str(), CallableKind::Workflow),
            policy: WorkflowExecutionPolicy::Sequential,
            steps: vec![WorkflowStep {
                callable: agent,
                objective: Some("Implement the bounded change.".to_owned()),
            }],
        })
        .unwrap();

    let session = runtime
        .create_session(None, None, ExecutionTarget::Fixed(target()))
        .unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();
    let workflow_execution = runtime
        .start_workflow(&root.id, &workflow, "Fix routing selection")
        .unwrap();
    let child = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| execution.parent_execution.as_ref() == Some(&workflow_execution.id))
        .expect("workflow child exists");

    let invocation = runtime.resolve_invocation(&child.id).unwrap();
    assert_eq!(
        invocation.prompt,
        "Implement the bounded change.\n\nWorkflow objective:\nFix routing selection"
    );
}
