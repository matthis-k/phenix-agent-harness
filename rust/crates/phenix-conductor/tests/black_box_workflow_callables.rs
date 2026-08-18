use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolInvocation, ToolPresentation,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionEventKind, ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId,
    ModelTarget, ProviderId, RoutingProfile, RoutingProfileId, WorkflowDefinition,
    WorkflowExecutionPolicy, WorkflowStep,
};
use phenix_protocol::{ClientMessage, Command, Reply, ResponsePayload, ServerMessage};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufReader, Cursor};
use std::sync::{Arc, Mutex};

const WORKFLOW_ID: &str = "workflow.inspect-and-verify";
const WORKFLOW_OBJECTIVE: &str = "check the requested change";

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedTurn {
    model: String,
    prompt: String,
    tools: Vec<String>,
    tool_outputs: Vec<String>,
}

#[derive(Clone, Default)]
struct WorkflowRecorder {
    turns: Arc<Mutex<Vec<ObservedTurn>>>,
}

struct WorkflowBackend {
    recorder: WorkflowRecorder,
}

struct WorkflowSession {
    recorder: WorkflowRecorder,
    model: String,
    tools: Vec<String>,
}

impl Backend for WorkflowBackend {
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
        Ok(Arc::new(WorkflowSession {
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

impl BackendSession for WorkflowSession {
    fn execute(
        &self,
        request: BackendExecutionRequest,
        host: &mut dyn BackendHost,
    ) -> Result<(), BackendError> {
        let tool_outputs = if self.model == "root" {
            assert_eq!(
                self.tools,
                vec!["probe", "phenix_workflow_list", "phenix_workflow_start",]
            );

            let listed = host.invoke_tool(ToolInvocation {
                callable: CallableId::parse("phenix_workflow_list").unwrap(),
                arguments_json: "{}".to_owned(),
            })?;
            assert!(listed.success);
            let listed_json: Value = serde_json::from_str(&listed.output).unwrap();
            let workflow_ids = listed_json["workflows"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|workflow| workflow["id"].as_str())
                .collect::<Vec<_>>();
            assert_eq!(workflow_ids, vec![WORKFLOW_ID]);

            let started = host.invoke_tool(ToolInvocation {
                callable: CallableId::parse("phenix_workflow_start").unwrap(),
                arguments_json: json!({
                    "workflow": WORKFLOW_ID,
                    "objective": WORKFLOW_OBJECTIVE,
                })
                .to_string(),
            })?;
            assert!(started.success);
            let started_json: Value = serde_json::from_str(&started.output).unwrap();
            assert_eq!(started_json["callable"], WORKFLOW_ID);
            assert_eq!(started_json["kind"], "workflow");
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

        host.emit(BackendEvent::ContentDelta(format!(
            "{} completed",
            self.model
        )))?;
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
fn root_model_discovers_and_starts_workflow_then_worker_runs_mock_agents() {
    let recorder = WorkflowRecorder::default();
    let mut runtime = ConductorRuntime::new();
    runtime
        .register_tool(descriptor("probe", CallableKind::Tool), |arguments| {
            Ok(arguments.to_owned())
        })
        .unwrap();

    let scout = CallableId::parse("agent.scout").unwrap();
    let verifier = CallableId::parse("agent.verifier").unwrap();
    runtime
        .register_agent(descriptor(scout.as_str(), CallableKind::Agent))
        .unwrap();
    runtime
        .register_agent(descriptor(verifier.as_str(), CallableKind::Agent))
        .unwrap();

    let workflow = CallableId::parse(WORKFLOW_ID).unwrap();
    runtime
        .register_workflow(WorkflowDefinition {
            descriptor: descriptor(workflow.as_str(), CallableKind::Workflow),
            policy: WorkflowExecutionPolicy::Sequential,
            steps: vec![
                WorkflowStep {
                    callable: scout.clone(),
                    objective: Some("inspect the repository".to_owned()),
                },
                WorkflowStep {
                    callable: verifier.clone(),
                    objective: Some("verify the change".to_owned()),
                },
            ],
        })
        .unwrap();

    let routing = RoutingProfileId::parse("router.workflow-test").unwrap();
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
            Box::new(WorkflowBackend {
                recorder: recorder.clone(),
            }),
        )
        .unwrap();

    let input = request_lines(&[
        ClientMessage {
            id: 1,
            command: Command::CreateSession {
                parent_session: None,
                name: Some("workflow-test".to_owned()),
                target: ExecutionTarget::Routed(routing),
            },
        },
        ClientMessage {
            id: 2,
            command: Command::Submit {
                session_id: phenix_core::SessionId::parse("session-1").unwrap(),
                text:
                    "What can I call? Use the appropriate workflow to check the requested change."
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
    assert!(turns[1].prompt.contains(WORKFLOW_OBJECTIVE));
    assert_eq!(turns[1].tools, vec!["probe"]);
    assert_eq!(turns[1].tool_outputs, vec![r#"{"model":"scout"}"#]);

    assert_eq!(turns[2].model, "verifier");
    assert!(turns[2].prompt.contains("verify the change"));
    assert!(turns[2].prompt.contains(WORKFLOW_OBJECTIVE));
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

    let workflow_execution = snapshot
        .executions
        .iter()
        .find(|execution| execution.callable.as_ref() == Some(&workflow))
        .expect("workflow execution exists");
    assert_eq!(workflow_execution.parent_execution.as_ref(), Some(&root.id));
    assert_eq!(workflow_execution.state, ExecutionState::Completed);

    let children = snapshot
        .executions
        .iter()
        .filter(|execution| execution.parent_execution.as_ref() == Some(&workflow_execution.id))
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
            "phenix_workflow_list",
            "phenix_workflow_start",
            "probe",
            "probe",
        ]
    );
}
