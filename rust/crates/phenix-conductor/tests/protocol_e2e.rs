use phenix_backend::ToolPresentation;
use phenix_conductor::{
    CallableOperation, ConductorError, ConductorRuntime, InvocationGuard, InvocationPolicyContext,
    InvocationSubject, PolicyDenial,
};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionState, ExecutionTarget, WorkflowDefinition,
    WorkflowExecutionPolicy, WorkflowStep,
};
use phenix_protocol::Command;
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[path = "support/protocol_harness.rs"]
mod protocol_harness;

use protocol_harness::{
    execution_id, model_target, MockAction, MockBackend, MockBackendState, MockModelScript,
    ObservedAction, ProtocolHarness,
};

fn descriptor(id: &str, kind: CallableKind, requires_permission: bool) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind,
        description: "e2e test callable".to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy {
            requires_permission,
        },
    }
}

fn tool_descriptor(id: &str) -> CallableDescriptor {
    descriptor(id, CallableKind::Tool, false)
}

#[test]
fn frontend_input_reaches_prepared_mock_model_and_returns_events() {
    let run = ProtocolHarness::model(MockModelScript::reasoning_then_reply(["think"], "answer"))
        .input("hello")
        .run();

    assert!(run.response_ok(1));
    assert!(run.response_ok(2));
    assert!(run.response_ok(3));
    assert_eq!(run.backend.opened(), 1);
    assert_eq!(run.backend.executed(), 1);
    assert_eq!(run.backend.prompts(), vec!["hello"]);
    let opens = run.backend.opens();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0].model, model_target("mock-model"));
    assert!(opens[0].tool_ids.is_empty());
    assert_eq!(opens[0].tool_presentation, None);
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::ReasoningDelta { text } if text == "think"
        )
    }));
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::AssistantContentDelta { text } if text == "answer"
        )
    }));
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Completed));
}

#[test]
fn journal_replay_restart_continues_protocol_with_monotonic_ids_and_events() {
    let backend_state = Arc::new(MockBackendState::default());
    let mut backend = MockBackend::new(
        backend_state,
        MockModelScript::reply("before restart complete"),
    );
    let mut runtime = ConductorRuntime::new();
    let session = runtime
        .create_session(
            None,
            Some("restart-e2e".to_owned()),
            ExecutionTarget::Fixed(model_target("mock-model")),
        )
        .unwrap();
    let first = runtime.submit(&session.id, "before restart").unwrap();
    runtime.drive_execution(&first.id, &mut backend).unwrap();

    let before_restart = runtime.snapshot();
    assert_eq!(
        before_restart.executions[0].state,
        ExecutionState::Completed
    );
    let cursor = before_restart.last_event_sequence;
    let persisted = serde_json::to_vec(runtime.journal()).unwrap();
    let restored = ConductorRuntime::restore(serde_json::from_slice(&persisted).unwrap()).unwrap();
    assert_eq!(restored.snapshot(), before_restart);

    let run = ProtocolHarness::model(MockModelScript::reply("after restart complete"))
        .runtime(restored)
        .commands([
            Command::Initialize {
                after_sequence: Some(cursor),
            },
            Command::Submit {
                session_id: session.id,
                text: "after restart".to_owned(),
            },
        ])
        .run();

    assert!(run.response_ok(1));
    assert!(run.response_ok(2));
    assert_eq!(run.backend.prompts(), vec!["after restart"]);
    assert_eq!(run.snapshot.executions.len(), 2);
    let continued = run
        .snapshot
        .executions
        .iter()
        .find(|execution| execution.id == execution_id(2))
        .expect("continued execution uses replayed execution cursor");
    assert_eq!(continued.state, ExecutionState::Completed);
    let new_events = run
        .events()
        .filter(|event| event.sequence > cursor)
        .collect::<Vec<_>>();
    assert!(!new_events.is_empty());
    assert_eq!(new_events[0].sequence, cursor + 1);
    assert!(new_events.iter().all(|event| event.execution_id == execution_id(2)));
}

#[test]
fn streaming_order_and_cancellation_are_deterministic() {
    let run = ProtocolHarness::model(MockModelScript::sequence([
        MockAction::reasoning("thinking-1"),
        MockAction::content("chunk-1"),
        MockAction::content("chunk-2"),
        MockAction::await_cancel(),
    ]))
    .input("stream")
    .after_action(
        4,
        Command::CancelExecution {
            execution_id: execution_id(1),
        },
    )
    .run();

    assert!(run.response_ok(4));
    assert_eq!(run.backend.cancelled(), 1);
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Cancelled));
    assert_eq!(
        run.backend.actions(),
        vec![
            ObservedAction::Reasoning("thinking-1".to_owned()),
            ObservedAction::Content("chunk-1".to_owned()),
            ObservedAction::Content("chunk-2".to_owned()),
            ObservedAction::AwaitCancel,
        ]
    );

    let stream = run
        .events()
        .filter_map(|event| match &event.kind {
            ExecutionEventKind::ReasoningDelta { text } => Some(format!("reasoning:{text}")),
            ExecutionEventKind::AssistantContentDelta { text } => Some(format!("content:{text}")),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        stream,
        vec![
            "reasoning:thinking-1",
            "content:chunk-1",
            "content:chunk-2"
        ]
    );
}

struct DenyModels;

impl InvocationGuard for DenyModels {
    fn check(&self, context: &InvocationPolicyContext<'_>) -> Result<(), PolicyDenial> {
        if matches!(&context.subject, InvocationSubject::Model { .. }) {
            Err(PolicyDenial::new(
                "test_model_denial",
                "model denied by e2e guard",
            ))
        } else {
            Ok(())
        }
    }
}

#[test]
fn model_policy_denial_is_end_to_end_and_never_opens_backend() {
    let run = ProtocolHarness::model(MockModelScript::reply("must not execute"))
        .configure_runtime(|runtime| runtime.register_invocation_guard(DenyModels))
        .input("blocked")
        .run();

    assert_eq!(run.backend.opened(), 0);
    assert_eq!(run.backend.executed(), 0);
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Failed));
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::Error { code, message }
                if code == "policydenied" && message == "model denied by e2e guard"
        )
    }));
    assert!(!run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::AssistantContentDelta { .. }
        )
    }));
}

struct DenyEcho;

impl InvocationGuard for DenyEcho {
    fn check(&self, context: &InvocationPolicyContext<'_>) -> Result<(), PolicyDenial> {
        match &context.subject {
            InvocationSubject::Callable {
                descriptor,
                operation: CallableOperation::InvokeTool,
            } if descriptor.id.as_str() == "echo" => Err(PolicyDenial::new(
                "test_tool_denial",
                "echo denied by e2e guard",
            )
            .for_callable(descriptor.id.clone())),
            _ => Ok(()),
        }
    }
}

#[test]
fn tool_policy_denial_crosses_full_runtime_without_calling_handler() {
    let called = Arc::new(AtomicBool::new(false));
    let called_by_handler = called.clone();
    let run = ProtocolHarness::model(MockModelScript::tool(
        "echo",
        r#"{"value":"hello"}"#,
        "tool attempt observed",
    ))
    .with_tool_presentations([ToolPresentation::Native])
    .configure_runtime(move |runtime| {
        runtime
            .register_tool(tool_descriptor("echo"), move |arguments| {
                called_by_handler.store(true, Ordering::SeqCst);
                Ok(arguments.to_owned())
            })
            .unwrap();
        runtime.register_invocation_guard(DenyEcho);
    })
    .input("use echo")
    .run();

    assert_eq!(run.backend.opened(), 1);
    assert_eq!(run.backend.executed(), 1);
    assert!(!called.load(Ordering::SeqCst));
    let opens = run.backend.opens();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0].tool_presentation, Some(ToolPresentation::Native));
    assert_eq!(opens[0].tool_ids, vec![CallableId::parse("echo").unwrap()]);
    let results = run.backend.tool_results();
    assert_eq!(results.len(), 1);
    assert!(!results[0].success);
    assert_eq!(results[0].output, "echo denied by e2e guard");
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::ToolCallFinished { success: false, output, .. }
                if output == "echo denied by e2e guard"
        )
    }));
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Completed));
}

#[test]
fn built_in_permission_guard_suppresses_tool_handler_end_to_end() {
    let called = Arc::new(AtomicBool::new(false));
    let called_by_handler = called.clone();
    let run = ProtocolHarness::model(MockModelScript::tool(
        "guarded",
        "{}",
        "permission denial observed",
    ))
    .with_tool_presentations([ToolPresentation::Native])
    .configure_runtime(move |runtime| {
        runtime
            .register_tool(
                descriptor("guarded", CallableKind::Tool, true),
                move |arguments| {
                    called_by_handler.store(true, Ordering::SeqCst);
                    Ok(arguments.to_owned())
                },
            )
            .unwrap();
    })
    .input("use guarded")
    .run();

    assert!(!called.load(Ordering::SeqCst));
    let results = run.backend.tool_results();
    assert_eq!(results.len(), 1);
    assert!(!results[0].success);
    assert_eq!(
        results[0].output,
        "permission is required for callable guarded"
    );
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Completed));
}

#[test]
fn built_in_permission_guard_denies_agent_before_child_creation() {
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_agent(descriptor("guarded-agent", CallableKind::Agent, true))
        .unwrap();
    let session = runtime
        .create_session(
            None,
            None,
            ExecutionTarget::Fixed(model_target("mock-model")),
        )
        .unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();

    let error = runtime
        .start_agent(
            &root.id,
            &CallableId::parse("guarded-agent").unwrap(),
            "child",
        )
        .unwrap_err();

    assert!(matches!(
        error,
        ConductorError::PolicyDenied { ref denial, .. }
            if denial.code == "permission_required"
    ));
    assert_eq!(runtime.snapshot().executions.len(), 1);
}

#[test]
fn built_in_permission_guard_preflights_workflow_steps_before_creation() {
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_agent(descriptor("guarded-step", CallableKind::Agent, true))
        .unwrap();
    runtime
        .register_workflow(WorkflowDefinition {
            descriptor: descriptor("workflow", CallableKind::Workflow, false),
            policy: WorkflowExecutionPolicy::Sequential,
            steps: vec![WorkflowStep {
                callable: CallableId::parse("guarded-step").unwrap(),
                objective: None,
            }],
        })
        .unwrap();
    let session = runtime
        .create_session(
            None,
            None,
            ExecutionTarget::Fixed(model_target("mock-model")),
        )
        .unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();

    let error = runtime
        .start_workflow(
            &root.id,
            &CallableId::parse("workflow").unwrap(),
            "objective",
        )
        .unwrap_err();

    assert!(matches!(
        error,
        ConductorError::PolicyDenied { ref denial, .. }
            if denial.code == "permission_required"
    ));
    assert_eq!(runtime.snapshot().executions.len(), 1);
}

#[test]
fn scripted_backend_failure_is_visible_end_to_end() {
    let run = ProtocolHarness::model(MockModelScript::fail("mock model failed"))
        .input("fail")
        .run();

    assert_eq!(run.backend.opened(), 1);
    assert_eq!(run.backend.executed(), 1);
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Failed));
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::Error { code, message }
                if code == "backendprotocol" && message == "mock model failed"
        )
    }));
}
