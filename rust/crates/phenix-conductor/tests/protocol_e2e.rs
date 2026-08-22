use phenix_backend::ToolPresentation;
use phenix_conductor::{
    CallableOperation, ConductorError, ConductorRuntime, ExecutionProvider, ExecutionProviderError,
    ExecutionProviderEvent, ExecutionProviderHost, ExecutionProviderKind, ExecutionProviderRequest,
    InvocationGuard, InvocationPolicyContext, InvocationSubject, PolicyDenial,
};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionState, ExecutionTarget, OrchestrationDefinition,
    OrchestrationNode, OrchestrationNodeId,
};
use phenix_protocol::{Command, Reply};
use serde_json::json;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

#[path = "support/protocol_harness.rs"]
mod protocol_harness;

use protocol_harness::{
    execution_id, model_target, MockAction, MockModelScript, ObservedAction, ProtocolHarness,
    ProtocolSignal,
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

fn orchestration_node(
    id: &str,
    callable: &str,
    depends_on: &[&str],
    objective: Option<&str>,
) -> OrchestrationNode {
    OrchestrationNode {
        id: OrchestrationNodeId::parse(id).unwrap(),
        callable: CallableId::parse(callable).unwrap(),
        depends_on: depends_on
            .iter()
            .map(|dependency| OrchestrationNodeId::parse(*dependency).unwrap())
            .collect(),
        objective: objective.map(str::to_owned),
    }
}

fn tool_descriptor(id: &str) -> CallableDescriptor {
    descriptor(id, CallableKind::Tool, false)
}

#[test]
fn callable_catalog_is_conductor_owned_and_lists_all_registered_kinds() {
    let run = ProtocolHarness::model(MockModelScript::reply("model must not execute"))
        .configure_runtime(|runtime| {
            runtime
                .register_tool(tool_descriptor("tool.echo"), |arguments| {
                    Ok(arguments.to_owned())
                })
                .unwrap();
            runtime
                .register_agent(phenix_core::AgentDefinition::new(
                    descriptor("agent.catalog", CallableKind::Agent, false),
                    phenix_core::ExecutionAuthority::read_only(),
                ))
                .unwrap();
            runtime
                .register_orchestration(OrchestrationDefinition {
                    interface_agent: None,
                    descriptor: descriptor(
                        "orchestration.catalog",
                        CallableKind::Orchestration,
                        false,
                    ),
                    nodes: vec![orchestration_node(
                        "catalog",
                        "agent.catalog",
                        &[],
                        Some("catalog step"),
                    )],
                })
                .unwrap();
        })
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::GetCallableCatalog,
        ])
        .run();

    assert!(run.response_ok(1));
    assert!(run.response_ok(2));
    let Reply::CallableCatalog { callables } = run.reply(2).expect("callable catalog reply") else {
        panic!("callable catalog command returned the wrong reply type");
    };
    assert_eq!(callables.len(), 3);
    assert!(callables.iter().any(|descriptor| {
        descriptor.id.as_str() == "tool.echo" && descriptor.kind == CallableKind::Tool
    }));
    assert!(callables.iter().any(|descriptor| {
        descriptor.id.as_str() == "agent.catalog" && descriptor.kind == CallableKind::Agent
    }));
    assert!(callables.iter().any(|descriptor| {
        descriptor.id.as_str() == "orchestration.catalog"
            && descriptor.kind == CallableKind::Orchestration
    }));
    assert_eq!(run.backend.opened(), 0);
    assert_eq!(run.backend.executed(), 0);
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
    let before = ProtocolHarness::model(MockModelScript::reply("before restart complete"))
        .input("before restart")
        .run();

    assert!(before.response_ok(1));
    assert!(before.response_ok(2));
    assert!(before.response_ok(3));
    assert_eq!(before.backend.prompts(), vec!["before restart"]);
    assert_eq!(
        before.only_execution_state(),
        Some(&ExecutionState::Completed)
    );
    let before_restart = before.snapshot.clone();
    let session_id = before_restart.sessions[0].id.clone();
    let cursor = before_restart.last_event_sequence;
    let persisted = serde_json::to_vec(&before.journal).unwrap();
    let restored = ConductorRuntime::restore(serde_json::from_slice(&persisted).unwrap()).unwrap();
    assert_eq!(restored.snapshot(), before_restart);

    let after = ProtocolHarness::model(MockModelScript::reply("after restart complete"))
        .runtime(restored)
        .commands([
            Command::Initialize {
                after_sequence: Some(cursor),
            },
            Command::Submit {
                session_id,
                text: "after restart".to_owned(),
            },
        ])
        .run();

    assert!(after.response_ok(1));
    assert!(after.response_ok(2));
    assert_eq!(after.backend.prompts(), vec!["after restart"]);
    assert_eq!(after.snapshot.executions.len(), 2);
    let continued = after
        .snapshot
        .executions
        .iter()
        .find(|execution| execution.id == execution_id(2))
        .expect("continued execution uses replayed execution cursor");
    assert_eq!(continued.state, ExecutionState::Completed);
    let new_events = after
        .events()
        .filter(|event| event.sequence > cursor)
        .collect::<Vec<_>>();
    assert!(!new_events.is_empty());
    assert_eq!(new_events[0].sequence, cursor + 1);
    assert!(new_events
        .iter()
        .all(|event| event.execution_id == execution_id(2)));
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
        vec!["reasoning:thinking-1", "content:chunk-1", "content:chunk-2"]
    );
}

struct NativeProvider {
    calls: Arc<AtomicUsize>,
}

impl ExecutionProvider for NativeProvider {
    fn kind(&self) -> ExecutionProviderKind {
        ExecutionProviderKind::Native
    }

    fn execute(
        &self,
        request: &ExecutionProviderRequest,
        host: &mut dyn ExecutionProviderHost,
    ) -> Result<(), ExecutionProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        host.emit(ExecutionProviderEvent::ReasoningDelta(format!(
            "native reasoning: {}",
            request.objective
        )))?;
        host.emit(ExecutionProviderEvent::ContentDelta(format!(
            "native answer: {}",
            request.objective
        )))
    }
}

#[test]
fn typed_callable_command_executes_native_provider_without_model_backend() {
    let calls = Arc::new(AtomicUsize::new(0));
    let provider_calls = calls.clone();
    let run = ProtocolHarness::model(MockModelScript::reply("model must not execute"))
        .configure_runtime(move |runtime| {
            runtime
                .register_provider_agent(
                    phenix_core::AgentDefinition::new(
                        descriptor("agent.native", CallableKind::Agent, false),
                        phenix_core::ExecutionAuthority::read_only(),
                    ),
                    NativeProvider {
                        calls: provider_calls,
                    },
                )
                .unwrap();
        })
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("native".to_owned()),
                target: ExecutionTarget::Fixed(model_target("mock-model")),
            },
            Command::StartCallable {
                session_id: phenix_core::SessionId::parse("session-1").unwrap(),
                callable: CallableId::parse("agent.native").unwrap(),
                objective: "inspect repository".to_owned(),
            },
        ])
        .run();

    assert!(run.response_ok(1));
    assert!(run.response_ok(2));
    assert!(run.response_ok(3));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(run.backend.opened(), 0);
    assert_eq!(run.backend.executed(), 0);
    assert_eq!(run.snapshot.executions.len(), 1);
    let execution = &run.snapshot.executions[0];
    assert_eq!(execution.parent_execution, None);
    assert_eq!(
        execution.callable,
        Some(CallableId::parse("agent.native").unwrap())
    );
    assert_eq!(execution.state, ExecutionState::Completed);
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::ReasoningDelta { text }
                if text == "native reasoning: inspect repository"
        )
    }));
    assert!(run.has_event(|event| {
        matches!(
            &event.kind,
            ExecutionEventKind::AssistantContentDelta { text }
                if text == "native answer: inspect repository"
        )
    }));
}

struct BlockingNativeProvider {
    started: Arc<ProtocolSignal>,
    released: Arc<ProtocolSignal>,
    cancelled: Arc<AtomicUsize>,
}

impl ExecutionProvider for BlockingNativeProvider {
    fn kind(&self) -> ExecutionProviderKind {
        ExecutionProviderKind::Native
    }

    fn execute(
        &self,
        _request: &ExecutionProviderRequest,
        _host: &mut dyn ExecutionProviderHost,
    ) -> Result<(), ExecutionProviderError> {
        self.started.signal();
        self.released.wait();
        Ok(())
    }

    fn cancel(
        &self,
        _execution_id: &phenix_core::ExecutionId,
    ) -> Result<(), ExecutionProviderError> {
        self.cancelled.fetch_add(1, Ordering::SeqCst);
        self.released.signal();
        Ok(())
    }
}

#[test]
fn active_native_provider_cancellation_is_deterministic_and_never_uses_model_backend() {
    let started = Arc::new(ProtocolSignal::default());
    let released = Arc::new(ProtocolSignal::default());
    let cancelled = Arc::new(AtomicUsize::new(0));
    let provider_started = started.clone();
    let provider_released = released.clone();
    let provider_cancelled = cancelled.clone();

    let run = ProtocolHarness::model(MockModelScript::reply("model must not execute"))
        .configure_runtime(move |runtime| {
            runtime
                .register_provider_agent(
                    phenix_core::AgentDefinition::new(
                        descriptor("agent.blocking", CallableKind::Agent, false),
                        phenix_core::ExecutionAuthority::read_only(),
                    ),
                    BlockingNativeProvider {
                        started: provider_started,
                        released: provider_released,
                        cancelled: provider_cancelled,
                    },
                )
                .unwrap();
        })
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("native cancellation".to_owned()),
                target: ExecutionTarget::Fixed(model_target("mock-model")),
            },
            Command::StartCallable {
                session_id: phenix_core::SessionId::parse("session-1").unwrap(),
                callable: CallableId::parse("agent.blocking").unwrap(),
                objective: "wait until cancelled".to_owned(),
            },
        ])
        .after_signal(
            started,
            Command::CancelExecution {
                execution_id: execution_id(1),
            },
        )
        .run();

    assert!(run.response_ok(4));
    assert_eq!(cancelled.load(Ordering::SeqCst), 1);
    assert_eq!(run.backend.opened(), 0);
    assert_eq!(run.backend.executed(), 0);
    assert_eq!(run.only_execution_state(), Some(&ExecutionState::Cancelled));
}

#[test]
fn typed_workflow_command_schedules_all_model_steps_without_wrapper_root() {
    let run = ProtocolHarness::model(MockModelScript::reply("step complete"))
        .configure_runtime(|runtime| {
            runtime
                .register_agent(phenix_core::AgentDefinition::new(
                    descriptor("agent.first", CallableKind::Agent, false),
                    phenix_core::ExecutionAuthority::read_only(),
                ))
                .unwrap();
            runtime
                .register_agent(phenix_core::AgentDefinition::new(
                    descriptor("agent.second", CallableKind::Agent, false),
                    phenix_core::ExecutionAuthority::read_only(),
                ))
                .unwrap();
            runtime
                .register_orchestration(OrchestrationDefinition {
                    interface_agent: None,
                    descriptor: descriptor(
                        "orchestration.two-step",
                        CallableKind::Orchestration,
                        false,
                    ),
                    nodes: vec![
                        orchestration_node("first", "agent.first", &[], Some("first step")),
                        orchestration_node(
                            "second",
                            "agent.second",
                            &["first"],
                            Some("second step"),
                        ),
                    ],
                })
                .unwrap();
        })
        .commands([
            Command::Initialize {
                after_sequence: Some(0),
            },
            Command::CreateSession {
                parent_session: None,
                name: Some("orchestration".to_owned()),
                target: ExecutionTarget::Fixed(model_target("mock-model")),
            },
            Command::StartCallable {
                session_id: phenix_core::SessionId::parse("session-1").unwrap(),
                callable: CallableId::parse("orchestration.two-step").unwrap(),
                objective: "overall objective".to_owned(),
            },
        ])
        .run();

    assert!(run.response_ok(1));
    assert!(run.response_ok(2));
    assert!(run.response_ok(3));
    assert_eq!(run.backend.opened(), 2);
    assert_eq!(run.backend.executed(), 2);
    assert_eq!(
        run.backend.prompts(),
        vec![
            "first step\n\nOrchestration objective:\noverall objective",
            "second step\n\nOrchestration objective:\noverall objective",
        ]
    );
    assert_eq!(run.snapshot.executions.len(), 3);

    let orchestration = run
        .snapshot
        .executions
        .iter()
        .find(|execution| {
            execution
                .callable
                .as_ref()
                .is_some_and(|id| id.as_str() == "orchestration.two-step")
        })
        .expect("orchestration execution exists");
    assert_eq!(orchestration.parent_execution, None);
    assert_eq!(orchestration.state, ExecutionState::Completed);
    let children = run
        .snapshot
        .executions
        .iter()
        .filter(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 2);
    assert!(children
        .iter()
        .all(|execution| execution.state == ExecutionState::Completed));
    assert!(!run
        .snapshot
        .executions
        .iter()
        .any(|execution| execution.kind == phenix_core::ExecutionKind::Root));
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
        .register_agent(phenix_core::AgentDefinition::new(
            descriptor("guarded-agent", CallableKind::Agent, true),
            phenix_core::ExecutionAuthority::read_only(),
        ))
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
        .register_agent(phenix_core::AgentDefinition::new(
            descriptor("guarded-step", CallableKind::Agent, true),
            phenix_core::ExecutionAuthority::read_only(),
        ))
        .unwrap();
    runtime
        .register_orchestration(OrchestrationDefinition {
            interface_agent: None,
            descriptor: descriptor("orchestration", CallableKind::Orchestration, false),
            nodes: vec![orchestration_node("guarded", "guarded-step", &[], None)],
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
        .start_orchestration(
            &root.id,
            &CallableId::parse("orchestration").unwrap(),
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
