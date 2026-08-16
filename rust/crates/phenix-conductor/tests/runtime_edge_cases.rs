use phenix_backend::ToolPresentation;
use phenix_conductor::{ConductorError, ConductorRuntime};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionKind, ExecutionState, ExecutionTarget, SessionId,
    WorkflowDefinition, WorkflowExecutionPolicy, WorkflowStep,
};
use phenix_protocol::Command;
use serde_json::json;

#[path = "support/canonical_journeys.rs"]
mod canonical_journeys;
#[path = "support/protocol_harness.rs"]
mod protocol_harness;

use protocol_harness::{execution_id, model_target, MockAction, MockModelScript, ProtocolHarness};

fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind,
        description: "edge-case fixture callable".to_owned(),
        input_schema: json!({"type": "object"}),
        output_schema: json!({"type": "object"}),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

fn fixed_target() -> ExecutionTarget {
    ExecutionTarget::Fixed(model_target("mock-model"))
}

fn session_id(index: u64) -> SessionId {
    SessionId::parse(format!("session-{index}")).unwrap()
}

#[test]
fn rejected_session_creation_does_not_consume_session_identity() {
    let mut runtime = ConductorRuntime::new();
    let before_entries = runtime.journal().entries.len();

    let error = runtime
        .create_session(
            Some(SessionId::parse("session-999").unwrap()),
            Some("invalid child".to_owned()),
            fixed_target(),
        )
        .unwrap_err();

    assert!(matches!(error, ConductorError::UnknownSession(_)));
    assert_eq!(runtime.journal().entries.len(), before_entries);
    assert!(runtime.snapshot().sessions.is_empty());

    let session = runtime
        .create_session(None, Some("valid".to_owned()), fixed_target())
        .unwrap();
    assert_eq!(session.id, session_id(1));
}

#[test]
fn rejected_empty_submit_does_not_consume_execution_identity_or_emit_events() {
    let mut runtime = ConductorRuntime::new();
    let session = runtime.create_session(None, None, fixed_target()).unwrap();
    let before_entries = runtime.journal().entries.len();
    let before_events = runtime.events_since(0);

    let error = runtime.submit(&session.id, " \n\t ").unwrap_err();

    assert_eq!(error, ConductorError::EmptyInput);
    assert_eq!(runtime.journal().entries.len(), before_entries);
    assert_eq!(runtime.events_since(0), before_events);
    assert!(runtime.snapshot().executions.is_empty());

    let execution = runtime.submit(&session.id, "valid").unwrap();
    assert_eq!(execution.id, execution_id(1));
}

#[test]
fn frontend_layer_can_start_a_registered_top_level_callable_without_a_wrapper_execution() {
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_agent(descriptor("scout", CallableKind::Agent))
        .unwrap();
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
    let before_entries = runtime.journal().entries.len();
    let before_events = runtime.events_since(0);

    let result = runtime.start_session_callable(
        &session.id,
        &CallableId::parse("missing").unwrap(),
        "inspect the repository",
    );

    assert!(matches!(result, Err(ConductorError::CallableRegistry(_))));
    assert!(runtime.snapshot().executions.is_empty());
    assert_eq!(runtime.journal().entries.len(), before_entries);
    assert_eq!(runtime.events_since(0), before_events);
}

#[test]
fn cancelling_unknown_execution_is_side_effect_free() {
    let mut runtime = ConductorRuntime::new();
    let session = runtime.create_session(None, None, fixed_target()).unwrap();
    let execution = runtime.submit(&session.id, "work").unwrap();
    let before_snapshot = runtime.snapshot();
    let before_entries = runtime.journal().entries.len();
    let before_events = runtime.events_since(0);

    let error = runtime
        .cancel_execution(&execution_id(999))
        .expect_err("unknown cancellation must fail");

    assert!(matches!(error, ConductorError::UnknownExecution(_)));
    assert_eq!(runtime.snapshot(), before_snapshot);
    assert_eq!(runtime.journal().entries.len(), before_entries);
    assert_eq!(runtime.events_since(0), before_events);
    assert_eq!(
        runtime
            .snapshot()
            .executions
            .iter()
            .find(|candidate| candidate.id == execution.id)
            .unwrap()
            .state,
        ExecutionState::Pending
    );
}

#[test]
fn repeated_cancellation_is_idempotent_and_does_not_duplicate_events() {
    let mut runtime = ConductorRuntime::new();
    let session = runtime.create_session(None, None, fixed_target()).unwrap();
    let execution = runtime.submit(&session.id, "work").unwrap();

    runtime.cancel_execution(&execution.id).unwrap();
    let after_first_entries = runtime.journal().entries.len();
    let after_first_events = runtime.events_since(0);

    runtime.cancel_execution(&execution.id).unwrap();

    assert_eq!(runtime.journal().entries.len(), after_first_entries);
    assert_eq!(runtime.events_since(0), after_first_events);
    assert_eq!(
        runtime.snapshot().executions[0].state,
        ExecutionState::Cancelled
    );
}

#[test]
fn cancelling_completed_execution_is_a_durable_noop() {
    let completed = ProtocolHarness::model(MockModelScript::reply("done"))
        .input("complete")
        .run();
    assert_eq!(
        completed.only_execution_state(),
        Some(&ExecutionState::Completed)
    );

    let mut runtime = ConductorRuntime::restore(completed.journal).unwrap();
    let before_snapshot = runtime.snapshot();
    let before_entries = runtime.journal().entries.len();
    let before_events = runtime.events_since(0);

    runtime.cancel_execution(&execution_id(1)).unwrap();

    assert_eq!(runtime.snapshot(), before_snapshot);
    assert_eq!(runtime.journal().entries.len(), before_entries);
    assert_eq!(runtime.events_since(0), before_events);
}

#[test]
fn cancelled_turn_can_be_followed_by_a_new_turn_after_replay() {
    let cancelled = ProtocolHarness::model(MockModelScript::sequence([
        MockAction::content("partial"),
        MockAction::await_cancel(),
    ]))
    .input("cancel me")
    .after_action(
        2,
        Command::CancelExecution {
            execution_id: execution_id(1),
        },
    )
    .run();
    assert_eq!(
        cancelled.only_execution_state(),
        Some(&ExecutionState::Cancelled)
    );

    let cursor = cancelled.snapshot.last_event_sequence;
    let session = cancelled.snapshot.sessions[0].id.clone();
    let restored = ConductorRuntime::restore(cancelled.journal).unwrap();
    let continued = ProtocolHarness::model(MockModelScript::reply("recovered"))
        .runtime(restored)
        .commands([
            Command::Initialize {
                after_sequence: Some(cursor),
            },
            Command::Submit {
                session_id: session,
                text: "next turn".to_owned(),
            },
        ])
        .run();

    assert!(continued.response_ok(1));
    assert!(continued.response_ok(2));
    assert_eq!(continued.backend.prompts(), vec!["next turn"]);
    assert_eq!(continued.snapshot.executions.len(), 2);
    assert_eq!(
        continued.snapshot.executions[0].state,
        ExecutionState::Cancelled
    );
    assert_eq!(continued.snapshot.executions[1].id, execution_id(2));
    assert_eq!(
        continued.snapshot.executions[1].state,
        ExecutionState::Completed
    );
}

#[test]
fn failed_turn_can_be_followed_by_a_new_turn_after_replay() {
    let failed = ProtocolHarness::model(MockModelScript::fail("boom"))
        .input("fail once")
        .run();
    assert_eq!(failed.only_execution_state(), Some(&ExecutionState::Failed));

    let cursor = failed.snapshot.last_event_sequence;
    let session = failed.snapshot.sessions[0].id.clone();
    let restored = ConductorRuntime::restore(failed.journal).unwrap();
    let continued = ProtocolHarness::model(MockModelScript::reply("healthy again"))
        .runtime(restored)
        .commands([
            Command::Initialize {
                after_sequence: Some(cursor),
            },
            Command::Submit {
                session_id: session,
                text: "retry".to_owned(),
            },
        ])
        .run();

    assert_eq!(continued.backend.prompts(), vec!["retry"]);
    assert_eq!(continued.snapshot.executions.len(), 2);
    assert_eq!(
        continued.snapshot.executions[0].state,
        ExecutionState::Failed
    );
    assert_eq!(continued.snapshot.executions[1].id, execution_id(2));
    assert_eq!(
        continued.snapshot.executions[1].state,
        ExecutionState::Completed
    );
}

#[test]
fn multiple_turns_in_one_session_keep_execution_events_separate() {
    let run = ProtocolHarness::model(MockModelScript::reply("answer"))
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("root".to_owned()),
                target: fixed_target(),
            },
            Command::Submit {
                session_id: session_id(1),
                text: "first".to_owned(),
            },
            Command::Submit {
                session_id: session_id(1),
                text: "second".to_owned(),
            },
        ])
        .run();

    for id in 1..=4 {
        assert!(run.response_ok(id));
    }
    assert_eq!(run.backend.opened(), 2);
    assert_eq!(run.backend.executed(), 2);
    let mut prompts = run.backend.prompts();
    prompts.sort();
    assert_eq!(prompts, vec!["first", "second"]);
    assert_eq!(run.snapshot.executions.len(), 2);
    assert!(run
        .snapshot
        .executions
        .iter()
        .all(|execution| execution.session_id == session_id(1)
            && execution.state == ExecutionState::Completed));
    assert!(run.has_event(|event| {
        event.execution_id == execution_id(1)
            && matches!(&event.kind, ExecutionEventKind::UserInput { text } if text == "first")
    }));
    assert!(run.has_event(|event| {
        event.execution_id == execution_id(2)
            && matches!(&event.kind, ExecutionEventKind::UserInput { text } if text == "second")
    }));
}

#[test]
fn separate_sessions_do_not_cross_execution_or_event_ownership() {
    let run = ProtocolHarness::model(MockModelScript::reply("answer"))
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("one".to_owned()),
                target: fixed_target(),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("two".to_owned()),
                target: fixed_target(),
            },
            Command::Submit {
                session_id: session_id(1),
                text: "session one".to_owned(),
            },
            Command::Submit {
                session_id: session_id(2),
                text: "session two".to_owned(),
            },
        ])
        .run();

    for id in 1..=5 {
        assert!(run.response_ok(id));
    }
    assert_eq!(run.snapshot.sessions.len(), 2);
    assert_eq!(run.snapshot.executions.len(), 2);
    assert_eq!(run.snapshot.executions[0].session_id, session_id(1));
    assert_eq!(run.snapshot.executions[1].session_id, session_id(2));
    assert!(run.has_event(|event| {
        event.execution_id == execution_id(1)
            && matches!(&event.kind, ExecutionEventKind::UserInput { text } if text == "session one")
    }));
    assert!(run.has_event(|event| {
        event.execution_id == execution_id(2)
            && matches!(&event.kind, ExecutionEventKind::UserInput { text } if text == "session two")
    }));
}

#[test]
fn cancelling_root_cascades_through_workflow_without_starting_later_steps() {
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_agent(descriptor("agent.first", CallableKind::Agent))
        .unwrap();
    runtime
        .register_agent(descriptor("agent.second", CallableKind::Agent))
        .unwrap();
    runtime
        .register_workflow(WorkflowDefinition {
            descriptor: descriptor("workflow.edge", CallableKind::Workflow),
            policy: WorkflowExecutionPolicy::Sequential,
            steps: vec![
                WorkflowStep {
                    callable: CallableId::parse("agent.first").unwrap(),
                    objective: Some("first".to_owned()),
                },
                WorkflowStep {
                    callable: CallableId::parse("agent.second").unwrap(),
                    objective: Some("second".to_owned()),
                },
            ],
        })
        .unwrap();
    let session = runtime.create_session(None, None, fixed_target()).unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();
    let workflow = runtime
        .start_workflow(
            &root.id,
            &CallableId::parse("workflow.edge").unwrap(),
            "workflow",
        )
        .unwrap();

    assert_eq!(runtime.snapshot().executions.len(), 3);
    runtime.cancel_execution(&root.id).unwrap();

    let snapshot = runtime.snapshot();
    assert_eq!(snapshot.executions.len(), 3);
    assert!(snapshot.executions.iter().all(|execution| {
        execution.id == root.id
            || execution.id == workflow.id
            || execution.parent_execution.as_ref() == Some(&workflow.id)
    }));
    assert!(snapshot
        .executions
        .iter()
        .all(|execution| execution.state == ExecutionState::Cancelled));
    assert!(!snapshot.executions.iter().any(|execution| {
        execution
            .callable
            .as_ref()
            .is_some_and(|callable| callable.as_str() == "agent.second")
    }));
}

#[test]
fn tool_handler_failure_is_contained_and_model_can_continue() {
    let run = ProtocolHarness::model(MockModelScript::sequence([
        MockAction::tool("unstable", "{}"),
        MockAction::content("continued after tool error"),
    ]))
    .with_tool_presentations([ToolPresentation::Native])
    .configure_runtime(|runtime| {
        runtime
            .register_tool(descriptor("unstable", CallableKind::Tool), |_| {
                Err("tool exploded".to_owned())
            })
            .unwrap();
    })
    .input("use unstable")
    .run();

    let results = run.backend.tool_results();
    assert_eq!(results.len(), 1);
    assert!(!results[0].success);
    assert_eq!(results[0].output, "tool exploded");
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::ToolCallFinished {
                success: false,
                output,
                ..
            } if output == "tool exploded"
        )
    }));
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::AssistantContentDelta { text }
                if text == "continued after tool error"
        )
    }));
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Completed));
}