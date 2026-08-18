use phenix_backend::{
    Backend, BackendCapabilities, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSession, BackendSessionRequest, ToolInvocation, ToolPresentation,
};
use phenix_conductor::{ConductorRuntime, ConductorServer};
use phenix_core::{
    BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
    ExecutionState, ExecutionTarget, InferenceOptions, ModelId, ModelTarget, ProviderId,
    RoutingProfile, RoutingProfileId, WorkflowDefinition, WorkflowExecutionPolicy, WorkflowStep,
};
use phenix_protocol::{ClientMessage, Command, Reply, ResponsePayload, ServerMessage};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufReader, Cursor};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Eq, PartialEq)]
struct ObservedTurn {
    model: String,
    prompt: String,
    tools: Vec<String>,
    tool_output: String,
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
        let result = host.invoke_tool(ToolInvocation {
            callable: CallableId::parse("probe").unwrap(),
            arguments_json: json!({ "model": self.model }).to_string(),
        })?;
        assert!(result.success);
        host.emit(BackendEvent::ContentDelta(format!(
            "{} completed",
            self.model
        )))?;
        self.recorder.turns.lock().unwrap().push(ObservedTurn {
            model: self.model.clone(),
            prompt: request.prompt,
            tools: self.tools.clone(),
            tool_output: result.output,
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
fn workflow_catalog_and_execution_use_the_real_server_and_agent_tool_path() {
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

    let workflow = CallableId::parse("workflow.inspect-and-verify").unwrap();
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
            command: Command::GetCallableCatalog,
        },
        ClientMessage {
            id: 2,
            command: Command::CreateSession {
                parent_session: None,
                name: Some("workflow-test".to_owned()),
                target: ExecutionTarget::Routed(routing),
            },
        },
        ClientMessage {
            id: 3,
            command: Command::StartCallable {
                session_id: phenix_core::SessionId::parse("session-1").unwrap(),
                callable: workflow.clone(),
                objective: "check the requested change".to_owned(),
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

    let catalog = messages
        .iter()
        .find_map(|message| match message {
            ServerMessage::Response {
                id: 1,
                response:
                    ResponsePayload::Ok {
                        result: Reply::CallableCatalog { callables },
                    },
            } => Some(callables),
            _ => None,
        })
        .expect("callable catalog response");
    let callable_kinds = catalog
        .iter()
        .map(|descriptor| (descriptor.id.as_str(), descriptor.kind.clone()))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(callable_kinds.get("probe"), Some(&CallableKind::Tool));
    assert_eq!(callable_kinds.get("agent.scout"), Some(&CallableKind::Agent));
    assert_eq!(
        callable_kinds.get("agent.verifier"),
        Some(&CallableKind::Agent)
    );
    assert_eq!(
        callable_kinds.get("workflow.inspect-and-verify"),
        Some(&CallableKind::Workflow)
    );

    assert!(messages.iter().any(|message| {
        matches!(
            message,
            ServerMessage::Response {
                id: 3,
                response: ResponsePayload::Ok {
                    result: Reply::Execution { execution },
                },
            } if execution.callable.as_ref() == Some(&workflow)
                && execution.kind == phenix_core::ExecutionKind::Workflow
        )
    }));

    let turns = recorder.turns.lock().unwrap().clone();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0].model, "scout");
    assert!(turns[0].prompt.contains("inspect the repository"));
    assert!(turns[0].prompt.contains("check the requested change"));
    assert_eq!(turns[0].tools, vec!["probe"]);
    assert_eq!(turns[0].tool_output, r#"{"model":"scout"}"#);

    assert_eq!(turns[1].model, "verifier");
    assert!(turns[1].prompt.contains("verify the change"));
    assert!(turns[1].prompt.contains("check the requested change"));
    assert_eq!(turns[1].tools, vec!["probe"]);
    assert_eq!(turns[1].tool_output, r#"{"model":"verifier"}"#);

    let snapshot = server.runtime().snapshot();
    let workflow_execution = snapshot
        .executions
        .iter()
        .find(|execution| execution.callable.as_ref() == Some(&workflow))
        .expect("workflow execution exists");
    assert_eq!(workflow_execution.state, ExecutionState::Completed);
    assert_eq!(
        snapshot
            .executions
            .iter()
            .filter(|execution| {
                execution.parent_execution.as_ref() == Some(&workflow_execution.id)
            })
            .count(),
        2
    );
    assert!(snapshot.executions.iter().filter(|execution| {
        execution.parent_execution.as_ref() == Some(&workflow_execution.id)
    }).all(|execution| execution.state == ExecutionState::Completed));
}
