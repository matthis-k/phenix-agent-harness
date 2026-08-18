use super::{descriptor, fixed_target, protocol_harness, session_id};
use phenix_backend::ToolPresentation;
use phenix_conductor::ConductorRuntime;
use phenix_core::{
    AgentNode, BackendId, CallableId, CallableKind, ExecutionEventKind, ExecutionState,
    ExecutionTarget, OrchestrationDefinition, OrchestrationPolicy, RoutingProfile,
    RoutingProfileId,
};
use phenix_protocol::{Command, ErrorCode, ProtocolError, Reply, ResponsePayload, ServerMessage};
use protocol_harness::{execution_id, model_target, MockAction, MockModelScript, ProtocolHarness};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

fn response_error(run: &protocol_harness::ProtocolRun, id: u64) -> &ProtocolError {
    run.messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::Response {
                id: response_id,
                response: ResponsePayload::Error { error },
            } if *response_id == id => Some(error),
            _ => None,
        })
        .unwrap_or_else(|| panic!("request {id} did not return a protocol error"))
}

fn bind_two_step_workflow(runtime: &mut ConductorRuntime) {
    runtime
        .register_agent(descriptor("agent.first", CallableKind::Agent))
        .unwrap();
    runtime
        .register_agent(descriptor("agent.second", CallableKind::Agent))
        .unwrap();
    runtime
        .register_orchestration(OrchestrationDefinition {
            descriptor: descriptor("workflow.two-step", CallableKind::Orchestration),
            policy: OrchestrationPolicy::Sequential,
            nodes: vec![
                AgentNode {
                    callable: CallableId::parse("agent.first").unwrap(),
                    objective: Some("first".to_owned()),
                },
                AgentNode {
                    callable: CallableId::parse("agent.second").unwrap(),
                    objective: Some("second".to_owned()),
                },
            ],
        })
        .unwrap();
}

#[test]
fn routed_session_executes_resolved_model_through_serialized_protocol() {
    let profile = RoutingProfileId::parse("protocol-route").unwrap();
    let routed = model_target("routed-model");
    let configured_profile = profile.clone();
    let configured_target = routed.clone();

    let run = ProtocolHarness::model(MockModelScript::reply("routed answer"))
        .configure_runtime(move |runtime| {
            runtime
                .register_routing_profile(RoutingProfile {
                    id: configured_profile,
                    default_target: configured_target,
                    callable_targets: BTreeMap::new(),
                })
                .unwrap();
        })
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("routed".to_owned()),
                target: ExecutionTarget::Routed(profile),
            },
            Command::Submit {
                session_id: session_id(1),
                text: "route me".to_owned(),
            },
        ])
        .run();

    assert!(run.response_ok(1));
    assert!(run.response_ok(2));
    assert!(run.response_ok(3));
    assert_eq!(run.backend.opened(), 1);
    assert_eq!(run.backend.executed(), 1);
    assert_eq!(run.backend.opens()[0].model, routed);
    assert_eq!(run.backend.prompts(), vec!["route me"]);
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Completed));
}

#[test]
fn invalid_protocol_commands_return_typed_errors_without_state_leakage() {
    let missing_session = session_id(999);
    let missing_execution = execution_id(999);
    let run = ProtocolHarness::model(MockModelScript::reply("unused"))
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::Submit {
                session_id: missing_session.clone(),
                text: "missing".to_owned(),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("valid".to_owned()),
                target: fixed_target(),
            },
            Command::Submit {
                session_id: session_id(1),
                text: " \n\t ".to_owned(),
            },
            Command::CancelExecution {
                execution_id: missing_execution.clone(),
            },
            Command::RenameSession {
                session_id: missing_session.clone(),
                name: "still missing".to_owned(),
            },
            Command::RefreshBackendCatalog {
                backend_id: BackendId::parse("missing-backend").unwrap(),
            },
        ])
        .run();

    assert!(run.response_ok(1));
    assert!(run.response_ok(3));

    let unknown_submit = response_error(&run, 2);
    assert_eq!(unknown_submit.code, ErrorCode::UnknownId);
    assert_eq!(unknown_submit.session_id.as_ref(), Some(&missing_session));

    let empty_submit = response_error(&run, 4);
    assert_eq!(empty_submit.code, ErrorCode::InvalidRequest);
    assert_eq!(empty_submit.message, "input must not be empty");

    let unknown_cancel = response_error(&run, 5);
    assert_eq!(unknown_cancel.code, ErrorCode::UnknownId);
    assert_eq!(
        unknown_cancel.execution_id.as_ref(),
        Some(&missing_execution)
    );

    let unknown_rename = response_error(&run, 6);
    assert_eq!(unknown_rename.code, ErrorCode::UnknownId);
    assert_eq!(unknown_rename.session_id.as_ref(), Some(&missing_session));

    assert_eq!(
        response_error(&run, 7).code,
        ErrorCode::UnsupportedCapability
    );
    assert_eq!(run.snapshot.sessions.len(), 1);
    assert!(run.snapshot.executions.is_empty());
    assert_eq!(run.backend.opened(), 0);
    assert_eq!(run.backend.executed(), 0);
}

#[test]
fn future_event_cursor_returns_snapshot_without_replaying_old_events() {
    let before = ProtocolHarness::model(MockModelScript::reply("done"))
        .input("seed")
        .run();
    let restored = ConductorRuntime::restore(before.journal.clone()).unwrap();

    let after = ProtocolHarness::model(MockModelScript::reply("unused"))
        .runtime(restored)
        .command(Command::Initialize {
            after_sequence: Some(u64::MAX),
        })
        .run();

    let Reply::Initialized {
        snapshot, events, ..
    } = after.reply(1).expect("initialize reply")
    else {
        panic!("initialize returned the wrong reply");
    };
    assert_eq!(snapshot, &before.snapshot);
    assert!(events.is_empty());
    assert_eq!(after.backend.executed(), 0);
}

#[test]
fn cancellation_before_tool_invocation_prevents_handler_and_tool_events() {
    let called = Arc::new(AtomicBool::new(false));
    let handler_called = called.clone();
    let run = ProtocolHarness::model(MockModelScript::sequence([
        MockAction::reasoning("before tool"),
        MockAction::await_cancel(),
        MockAction::tool("echo", "{}"),
        MockAction::content("must not continue"),
    ]))
    .with_tool_presentations([ToolPresentation::Native])
    .configure_runtime(move |runtime| {
        runtime
            .register_tool(descriptor("echo", CallableKind::Tool), move |arguments| {
                handler_called.store(true, Ordering::SeqCst);
                Ok(arguments.to_owned())
            })
            .unwrap();
    })
    .input("cancel before tool")
    .after_action(
        2,
        Command::CancelExecution {
            execution_id: execution_id(1),
        },
    )
    .run();

    assert!(run.response_ok(4));
    assert_eq!(run.backend.cancelled(), 1);
    assert!(!called.load(Ordering::SeqCst));
    assert!(run.backend.tool_results().is_empty());
    assert!(
        !run.has_event(|event| matches!(event.kind, ExecutionEventKind::ToolCallStarted { .. }))
    );
    assert!(!run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::AssistantContentDelta { text } if text == "must not continue"
        )
    }));
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Cancelled));
}

#[test]
fn cancellation_after_tool_result_keeps_result_but_rejects_model_continuation() {
    let run = ProtocolHarness::model(MockModelScript::sequence([
        MockAction::tool("echo", r#"{"value":"ok"}"#),
        MockAction::await_cancel(),
        MockAction::content("must not continue"),
    ]))
    .with_tool_presentations([ToolPresentation::Native])
    .configure_runtime(|runtime| {
        runtime
            .register_tool(descriptor("echo", CallableKind::Tool), |arguments| {
                Ok(arguments.to_owned())
            })
            .unwrap();
    })
    .input("cancel after tool")
    .after_action(
        2,
        Command::CancelExecution {
            execution_id: execution_id(1),
        },
    )
    .run();

    assert!(run.response_ok(4));
    assert_eq!(run.backend.cancelled(), 1);
    let results = run.backend.tool_results();
    assert_eq!(results.len(), 1);
    assert!(results[0].success);
    assert_eq!(results[0].output, r#"{"value":"ok"}"#);
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::ToolCallFinished {
                success: true,
                output,
                ..
            } if output == r#"{"value":"ok"}"#
        )
    }));
    assert!(!run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::AssistantContentDelta { text } if text == "must not continue"
        )
    }));
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Cancelled));
}

#[test]
fn session_fork_rename_and_model_retarget_survive_journal_replay() {
    let alternate = model_target("alternate-model");
    let run = ProtocolHarness::model(MockModelScript::reply("unused"))
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("root".to_owned()),
                target: fixed_target(),
            },
            Command::ForkSession {
                session_id: session_id(1),
                name: Some("fork".to_owned()),
            },
            Command::RenameSession {
                session_id: session_id(2),
                name: "renamed fork".to_owned(),
            },
            Command::SetSessionTarget {
                session_id: session_id(2),
                target: ExecutionTarget::Fixed(alternate.clone()),
            },
        ])
        .run();

    for id in 1..=5 {
        assert!(run.response_ok(id));
    }
    assert_eq!(run.snapshot.sessions.len(), 2);
    let fork = run
        .snapshot
        .sessions
        .iter()
        .find(|session| session.id == session_id(2))
        .unwrap();
    assert_eq!(fork.parent_session.as_ref(), Some(&session_id(1)));
    assert_eq!(fork.name.as_deref(), Some("renamed fork"));
    assert_eq!(
        fork.default_target,
        ExecutionTarget::Fixed(alternate.clone())
    );

    let restored = ConductorRuntime::restore(run.journal).unwrap();
    assert_eq!(restored.snapshot(), run.snapshot);
}

#[test]
fn multi_step_workflow_continues_after_replay_between_steps() {
    let mut runtime = ConductorRuntime::new();
    bind_two_step_workflow(&mut runtime);
    let session = runtime.create_session(None, None, fixed_target()).unwrap();
    let root = runtime.submit(&session.id, "root").unwrap();
    let workflow = runtime
        .start_orchestration(
            &root.id,
            &CallableId::parse("workflow.two-step").unwrap(),
            "workflow objective",
        )
        .unwrap();
    let first = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&workflow.id)
                && execution
                    .callable
                    .as_ref()
                    .is_some_and(|callable| callable.as_str() == "agent.first")
        })
        .unwrap();
    runtime
        .set_state(&first.id, ExecutionState::Completed)
        .unwrap();

    let before_restart = runtime.snapshot();
    let second = before_restart
        .executions
        .iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&workflow.id)
                && execution
                    .callable
                    .as_ref()
                    .is_some_and(|callable| callable.as_str() == "agent.second")
        })
        .unwrap()
        .clone();
    assert_eq!(second.state, ExecutionState::Pending);

    let serialized = serde_json::to_vec(runtime.journal()).unwrap();
    let mut restored =
        ConductorRuntime::restore(serde_json::from_slice(&serialized).unwrap()).unwrap();
    bind_two_step_workflow(&mut restored);
    assert_eq!(restored.snapshot(), before_restart);

    restored
        .set_state(&second.id, ExecutionState::Completed)
        .unwrap();
    let final_snapshot = restored.snapshot();
    assert_eq!(
        final_snapshot
            .executions
            .iter()
            .find(|execution| execution.id == workflow.id)
            .unwrap()
            .state,
        ExecutionState::Completed
    );
}
