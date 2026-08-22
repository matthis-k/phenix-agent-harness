use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolInvocation, ToolPresentation,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId,
    ModelTarget, OrchestrationDefinition, OrchestrationNode, OrchestrationNodeId,
    OrchestrationValueBinding, ProviderId, RoutingProfile, RoutingProfileId,
};
use phenix_protocol::{ClientMessage, Command, Reply, ResponsePayload, ServerMessage};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufReader, Cursor};
use std::sync::{Arc, Mutex};

const ORCHESTRATION_ID: &str = "orchestration.inspect-and-verify";
const ORCHESTRATION_OBJECTIVE: &str = "check the requested change";

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedTurn {
    model: String,
    prompt: String,
    tools: Vec<String>,
    tool_outputs: Vec<String>,
}

#[derive(Clone, Default)]
struct OrchestrationRecorder {
    turns: Arc<Mutex<Vec<ObservedTurn>>>,
}

struct OrchestrationBackend {
    recorder: OrchestrationRecorder,
}

struct OrchestrationSession {
    recorder: OrchestrationRecorder,
    model: String,
    tools: Vec<String>,
}

impl Backend for OrchestrationBackend {
    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities {
            tool_presentations: BTreeSet::from([ToolPresentation::Native]),
            images: false,
            persistent_sessions: false,
        }
    }

    fn open_session(
        &mut self,
        request: BackendSessionRequest,
    ) -> Result<Arc<dyn BackendSession>, BackendError> {
        assert_eq!(request.tools.presentation(), Some(ToolPresentation::Native));
        Ok(Arc::new(OrchestrationSession {
            recorder: self.recorder.clone(),
            model: request.model.model.as_str().to_owned(),
            tools: request
                .tools
                .callables()
                .iter()
                .map(|descriptor| descriptor.id.as_str().to_owned())
                .collect(),
        }))
    }
}

impl BackendSession for OrchestrationSession {
    fn execute(
        &self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        let tool_outputs = if self.model == "root" {
            assert_eq!(
                self.tools,
                vec![
                    "probe",
                    "phenix_orchestration_list",
                    "phenix_orchestration_start",
                ]
            );

            let listed = host.invoke_tool(ToolInvocation {
                callable: CallableId::parse("phenix_orchestration_list").unwrap(),
                arguments_json: "{}".to_owned(),
            })?;
            assert!(listed.success);
            let listed_json: Value = serde_json::from_str(&listed.output).unwrap();
            let orchestrations = listed_json["orchestrations"].as_array().unwrap();
            let orchestration_ids = orchestrations
                .iter()
                .filter_map(|orchestration| orchestration["id"].as_str())
                .collect::<Vec<_>>();
            assert_eq!(orchestration_ids, vec![ORCHESTRATION_ID]);
            assert!(orchestrations
                .iter()
                .all(|orchestration| orchestration["kind"] == "orchestration"));

            let started = host.invoke_tool(ToolInvocation {
                callable: CallableId::parse("phenix_orchestration_start").unwrap(),
                arguments_json: json!({
                    "orchestration": ORCHESTRATION_ID,
                    "objective": ORCHESTRATION_OBJECTIVE,
                })
                .to_string(),
            })?;
            assert!(started.success);
            let started_json: Value = serde_json::from_str(&started.output).unwrap();
            assert_eq!(started_json["callable"], ORCHESTRATION_ID);
            assert_eq!(started_json["kind"], "orchestration");
            assert_eq!(started_json["state"], "running");

            vec![listed.output, started.output]
        } else {
            assert_eq!(self.tools, vec!["probe"]);
            let result = host.invoke_tool(ToolInvocation {
                callable: CallableId::parse("probe").unwrap(),
                arguments_json: json!({ "model": self.model }).to_string(),
            })?;
            assert!(result.success);
            vec![result.output]
        };

        let content = if self.model == "root" {
            format!("{} completed", self.model)
        } else {
            json!({ "model": self.model, "status": "completed" }).to_string()
        };
        host.emit(BackendEvent::ContentDelta(content))?;
        self.recorder.turns.lock().unwrap().push(ObservedTurn {
            model: self.model.clone(),
            prompt: request.prompt,
            tools: self.tools.clone(),
            tool_outputs,
        });
        Ok(())
    }

    fn cancel(&self, _execution_id: &phenix_core::ExecutionId) -> Result<(), BackendError> {
        Ok(())
    }
}

fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).unwrap(),
        kind,
        description: format!("{id} black-box fixture"),
        input_schema: json!({ "type": "object" }),
        output_schema: json!({ "type": "object" }),
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy::default(),
    }
}

fn node(
    id: &str,
    callable: CallableId,
    depends_on: &[&str],
    objective: Option<&str>,
) -> OrchestrationNode {
    OrchestrationNode {
        input_bindings: BTreeMap::from([(
            "objective".to_owned(),
            OrchestrationValueBinding::Input {
                pointer: "/objective".to_owned(),
            },
        )]),
        id: OrchestrationNodeId::parse(id).unwrap(),
        callable,
        depends_on: depends_on
            .iter()
            .map(|dependency| OrchestrationNodeId::parse(*dependency).unwrap())
            .collect(),
        objective: objective.map(str::to_owned),
    }
}

fn model(name: &str) -> ModelTarget {
    ModelTarget {
        backend: BackendId::parse("fixture").unwrap(),
        provider: ProviderId::parse("fixture").unwrap(),
        model: ModelId::parse(name).unwrap(),
        inference: InferenceOptions::default(),
    }
}

fn request_lines(messages: &[ClientMessage]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for message in messages {
        serde_json::to_writer(&mut bytes, message).unwrap();
        bytes.push(b'\n');
    }
    bytes
}

#[test]
fn root_model_discovers_and_starts_orchestration_then_worker_runs_mock_agents() {
    let recorder = OrchestrationRecorder::default();
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_tool(descriptor("probe", CallableKind::Tool), |arguments| {
            Ok(arguments.to_owned())
        })
        .unwrap();

    let scout = CallableId::parse("agent.scout").unwrap();
    let verifier = CallableId::parse("agent.verifier").unwrap();
    runtime
        .register_agent(phenix_core::AgentDefinition::new(
            descriptor(scout.as_str(), CallableKind::Agent),
            phenix_core::ExecutionAuthority::read_only(),
        ))
        .unwrap();
    runtime
        .register_agent(phenix_core::AgentDefinition::new(
            descriptor(verifier.as_str(), CallableKind::Agent),
            phenix_core::ExecutionAuthority::read_only(),
        ))
        .unwrap();

    let orchestration = CallableId::parse(ORCHESTRATION_ID).unwrap();
    runtime
        .register_orchestration(OrchestrationDefinition {
            output_bindings: Default::default(),
            interface_agent: None,
            descriptor: descriptor(orchestration.as_str(), CallableKind::Orchestration),
            nodes: vec![
                node("scout", scout.clone(), &[], Some("inspect the repository")),
                node(
                    "verify",
                    verifier.clone(),
                    &["scout"],
                    Some("verify the change"),
                ),
            ],
        })
        .unwrap();

    let routing = RoutingProfileId::parse("router.orchestration-test").unwrap();
    runtime
        .register_routing_profile(RoutingProfile {
            id: routing.clone(),
            default_target: model("root"),
            callable_targets: BTreeMap::from([
                (scout.clone(), model("scout")),
                (verifier.clone(), model("verifier")),
            ]),
        })
        .unwrap();

    let mut server = ConductorServer::new(runtime);
    server
        .register_backend(
            BackendId::parse("fixture").unwrap(),
            Box::new(OrchestrationBackend {
                recorder: recorder.clone(),
            }),
        )
        .unwrap();

    let input = request_lines(&[
        ClientMessage {
            id: 1,
            command: Command::CreateSession {
                parent_session: None,
                name: Some("orchestration-test".to_owned()),
                target: ExecutionTarget::Routed(routing),
            },
        },
        ClientMessage {
            id: 2,
            command: Command::Submit {
                session_id: phenix_core::SessionId::parse("session-1").unwrap(),
                text: "What can I call? Use the appropriate orchestration to check the requested change."
                    .to_owned(),
            },
        },
    ]);
    let mut output = Vec::new();
    server
        .serve_ndjson(BufReader::new(Cursor::new(input)), &mut output)
        .unwrap();

    let messages = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<ServerMessage>(line).unwrap())
        .collect::<Vec<_>>();
    assert!(messages.iter().any(|message| {
        matches!(
            message,
            ServerMessage::Response {
                id: 2,
                response: ResponsePayload::Ok {
                    result: Reply::Execution { execution },
                },
            } if execution.kind == ExecutionKind::Root && execution.callable.is_none()
        )
    }));

    let turns = recorder.turns.lock().unwrap().clone();
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0].model, "root");
    assert!(turns[0].prompt.contains("What can I call?"));
    assert_eq!(turns[0].tool_outputs.len(), 2);

    assert_eq!(turns[1].model, "scout");
    assert!(turns[1].prompt.contains("inspect the repository"));
    assert!(turns[1].prompt.contains(ORCHESTRATION_OBJECTIVE));
    assert_eq!(turns[1].tools, vec!["probe"]);
    assert_eq!(turns[1].tool_outputs, vec![r#"{"model":"scout"}"#]);

    assert_eq!(turns[2].model, "verifier");
    assert!(turns[2].prompt.contains("verify the change"));
    assert!(turns[2].prompt.contains(ORCHESTRATION_OBJECTIVE));
    assert_eq!(turns[2].tools, vec!["probe"]);
    assert_eq!(turns[2].tool_outputs, vec![r#"{"model":"verifier"}"#]);

    let runtime = server.runtime();
    let snapshot = runtime.snapshot();
    let root = snapshot
        .executions
        .iter()
        .find(|execution| execution.kind == ExecutionKind::Root)
        .expect("root execution exists");
    assert_eq!(root.state, ExecutionState::Completed);

    let orchestration_execution = snapshot
        .executions
        .iter()
        .find(|execution| execution.callable.as_ref() == Some(&orchestration))
        .expect("orchestration execution exists");
    assert_eq!(
        orchestration_execution.parent_execution.as_ref(),
        Some(&root.id)
    );
    assert_eq!(orchestration_execution.state, ExecutionState::Completed);

    let children = snapshot
        .executions
        .iter()
        .filter(|execution| {
            execution.parent_execution.as_ref() == Some(&orchestration_execution.id)
        })
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 2);
    assert!(children
        .iter()
        .all(|execution| execution.state == ExecutionState::Completed));

    let tool_calls = runtime
        .events_since(0)
        .into_iter()
        .filter_map(|event| match event.kind {
            ExecutionEventKind::ToolCallStarted { callable, .. } => Some(callable.to_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(
        tool_calls,
        vec![
            "phenix_orchestration_list",
            "phenix_orchestration_start",
            "probe",
            "probe",
        ]
    );
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
    let alpha = CallableId::parse("agent.alpha").unwrap();
    let beta = CallableId::parse("agent.beta").unwrap();
    let join = CallableId::parse("agent.join").unwrap();
    for callable in [&alpha, &beta, &join] {
        runtime
            .register_agent(phenix_core::AgentDefinition::new(
                descriptor(callable.as_str(), CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ))
            .unwrap();
    }

    runtime
        .register_orchestration(OrchestrationDefinition {
            output_bindings: Default::default(),
            interface_agent: None,
            descriptor: descriptor("orchestration.parallel", CallableKind::Orchestration),
            nodes: vec![
                node("alpha", alpha.clone(), &[], None),
                node("beta", beta.clone(), &[], None),
                node("join", join.clone(), &["alpha", "beta"], None),
            ],
        })
        .unwrap();

    let session = runtime
        .create_session(None, None, ExecutionTarget::Fixed(model("fixed")))
        .unwrap();
    let root = runtime.submit(&session.id, "run the DAG").unwrap();
    let orchestration = runtime
        .start_orchestration(
            &root.id,
            &CallableId::parse("orchestration.parallel").unwrap(),
            serde_json::json!({"objective": "parallel work"}),
        )
        .unwrap();

    assert_eq!(
        child_states(&runtime, &orchestration.id),
        vec![
            (alpha.to_string(), ExecutionState::Pending),
            (beta.to_string(), ExecutionState::Pending),
        ],
        "all dependency-free nodes must become runnable together"
    );

    let alpha_execution = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&orchestration.id)
                && execution.callable.as_ref() == Some(&alpha)
        })
        .unwrap();
    runtime
        .set_state(&alpha_execution.id, ExecutionState::Completed)
        .unwrap();

    assert_eq!(
        child_states(&runtime, &orchestration.id),
        vec![
            (alpha.to_string(), ExecutionState::Completed),
            (beta.to_string(), ExecutionState::Pending),
        ],
        "join must stay blocked while one dependency is unfinished"
    );

    let beta_execution = runtime
        .snapshot()
        .executions
        .into_iter()
        .find(|execution| {
            execution.parent_execution.as_ref() == Some(&orchestration.id)
                && execution.callable.as_ref() == Some(&beta)
        })
        .unwrap();
    runtime
        .set_state(&beta_execution.id, ExecutionState::Completed)
        .unwrap();

    assert_eq!(
        child_states(&runtime, &orchestration.id),
        vec![
            (alpha.to_string(), ExecutionState::Completed),
            (beta.to_string(), ExecutionState::Completed),
            (join.to_string(), ExecutionState::Pending),
        ],
        "join becomes runnable only after every declared dependency completes"
    );
}
