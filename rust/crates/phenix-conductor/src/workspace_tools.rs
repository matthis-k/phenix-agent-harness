use phenix_conductor::{ConductorError, ConductorRuntime};
use phenix_core::{CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet};
use serde::Deserialize;
use serde_json::json;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

const MAX_CAPTURE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BashInput {
    command: String,
}

pub fn register(runtime: &mut ConductorRuntime, workspace: PathBuf) -> Result<(), ConductorError> {
    let description = format!(
        "Execute a Bash command in the current Phenix workspace ({}). Use this to inspect, search, modify, build, and test the repository instead of guessing about repository state.",
        workspace.display()
    );
    runtime.register_tool(
        CallableDescriptor {
            id: CallableId::parse("bash").expect("static callable id"),
            kind: CallableKind::Tool,
            description,
            input_schema: json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["command"],
                "properties": {
                    "command": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Bash program to execute in the current Phenix workspace"
                    }
                }
            }),
            output_schema: json!({
                "type": "object",
                "required": ["exit_code", "stdout", "stderr"],
                "properties": {
                    "exit_code": { "type": "integer" },
                    "stdout": { "type": "string" },
                    "stderr": { "type": "string" }
                }
            }),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy {
                requires_permission: false,
            },
        },
        move |arguments| execute_bash(&workspace, arguments),
    )
}

fn execute_bash(workspace: &Path, arguments: &str) -> Result<String, String> {
    let input: BashInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid bash arguments: {error}"))?;
    if input.command.trim().is_empty() {
        return Err("bash command must not be empty".to_owned());
    }

    let bash = std::env::var_os("PHENIX_BASH").unwrap_or_else(|| OsString::from("bash"));
    let output = Command::new(bash)
        .arg("-c")
        .arg(input.command)
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("failed to execute bash: {error}"))?;

    Ok(json!({
        "exit_code": output.status.code().unwrap_or(-1),
        "stdout": capture(&output.stdout),
        "stderr": capture(&output.stderr),
    })
    .to_string())
}

fn capture(bytes: &[u8]) -> String {
    if bytes.len() <= MAX_CAPTURE_BYTES {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut output = String::from_utf8_lossy(&bytes[..MAX_CAPTURE_BYTES]).into_owned();
    output.push_str("\n[Phenix truncated command output after 1048576 bytes]");
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_backend::{
        Backend, BackendCapabilities, BackendError, BackendExecutionRequest, BackendHost,
        BackendSession, BackendSessionRequest, ToolPresentation,
    };
    use phenix_core::{
        BackendId, ExecutionId, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
        ProviderId, RoutingProfile, RoutingProfileId, WorkflowDefinition, WorkflowExecutionPolicy,
        WorkflowStep,
    };
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Clone, Default)]
    struct ToolSurfaceRecorder {
        seen: Arc<Mutex<BTreeMap<String, Vec<String>>>>,
    }

    impl ToolSurfaceRecorder {
        fn assert_model_tools(&self, model: &str, expected: &[&str]) {
            let seen = self.seen.lock().unwrap();
            let actual = seen
                .get(model)
                .unwrap_or_else(|| panic!("model {model} was never opened"));
            assert_eq!(
                actual,
                &expected
                    .iter()
                    .map(|tool| (*tool).to_owned())
                    .collect::<Vec<_>>()
            );
        }
    }

    struct SurfaceBackend {
        recorder: ToolSurfaceRecorder,
    }

    struct SurfaceSession;

    impl Backend for SurfaceBackend {
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
            let tools = request
                .tools
                .callables()
                .iter()
                .map(|descriptor| descriptor.id.as_str().to_owned())
                .collect::<Vec<_>>();
            self.recorder
                .seen
                .lock()
                .unwrap()
                .insert(request.model.model.as_str().to_owned(), tools);
            Ok(Arc::new(SurfaceSession))
        }
    }

    impl BackendSession for SurfaceSession {
        fn execute(
            &self,
            _request: BackendExecutionRequest,
            _host: &mut dyn BackendHost,
        ) -> Result<(), BackendError> {
            Ok(())
        }

        fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), BackendError> {
            Ok(())
        }
    }

    fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind,
            description: format!("{id} test callable"),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    fn model(name: &str) -> ModelTarget {
        ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse(name).unwrap(),
            inference: InferenceOptions::default(),
        }
    }

    #[test]
    fn bash_executes_in_the_bound_workspace() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace =
            std::env::temp_dir().join(format!("phenix-bash-tool-{}-{unique}", std::process::id()));
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("marker.txt"), "workspace-marker").unwrap();

        let output = execute_bash(
            &workspace,
            r#"{"command":"printf '%s\\n' \"$(cat marker.txt)\" \"$PWD\""}"#,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        let stdout = output["stdout"].as_str().unwrap();
        assert!(stdout.contains("workspace-marker"));
        assert!(stdout.contains(workspace.to_string_lossy().as_ref()));

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn nonzero_exit_is_reported_without_failing_the_tool_call() {
        let output = execute_bash(
            Path::new("."),
            r#"{"command":"printf failure >&2; exit 7"}"#,
        )
        .unwrap();
        let output: serde_json::Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["exit_code"], 7);
        assert_eq!(output["stderr"], "failure");
    }

    #[test]
    fn default_tool_surface_reaches_root_and_every_agent_in_a_workflow() {
        let mut runtime = ConductorRuntime::new();
        register(&mut runtime, PathBuf::from(".")).unwrap();
        assert_eq!(
            runtime
                .tool_descriptors()
                .into_iter()
                .map(|descriptor| descriptor.id.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["bash".to_owned()]
        );

        let scout = CallableId::parse("agent.scout").unwrap();
        let implementer = CallableId::parse("agent.implementer").unwrap();
        let verifier = CallableId::parse("agent.verifier").unwrap();
        for agent in [&scout, &implementer, &verifier] {
            runtime
                .register_agent(descriptor(agent.as_str(), CallableKind::Agent))
                .unwrap();
        }

        let workflow_id = CallableId::parse("workflow.tool-surface").unwrap();
        runtime
            .register_workflow(WorkflowDefinition {
                descriptor: descriptor(workflow_id.as_str(), CallableKind::Workflow),
                policy: WorkflowExecutionPolicy::Sequential,
                steps: vec![
                    WorkflowStep {
                        callable: scout.clone(),
                        objective: Some("inspect the workspace".to_owned()),
                    },
                    WorkflowStep {
                        callable: implementer.clone(),
                        objective: Some("make the bounded change".to_owned()),
                    },
                    WorkflowStep {
                        callable: verifier.clone(),
                        objective: Some("verify the result".to_owned()),
                    },
                ],
            })
            .unwrap();

        let routing = RoutingProfileId::parse("router.tool-surface").unwrap();
        runtime
            .register_routing_profile(RoutingProfile {
                id: routing.clone(),
                default_target: model("root"),
                callable_targets: BTreeMap::from([
                    (scout.clone(), model("scout")),
                    (implementer.clone(), model("implementer")),
                    (verifier.clone(), model("verifier")),
                ]),
            })
            .unwrap();

        let session = runtime
            .create_session(None, None, ExecutionTarget::Routed(routing))
            .unwrap();
        let root = runtime
            .submit(&session.id, "exercise the workflow")
            .unwrap();
        let workflow = runtime
            .start_workflow(&root.id, &workflow_id, "change and verify")
            .unwrap();

        let recorder = ToolSurfaceRecorder::default();
        let mut backend = SurfaceBackend {
            recorder: recorder.clone(),
        };
        runtime.drive_execution(&root.id, &mut backend).unwrap();

        for (agent, model_name) in [
            (&scout, "scout"),
            (&implementer, "implementer"),
            (&verifier, "verifier"),
        ] {
            let child = runtime
                .snapshot()
                .executions
                .into_iter()
                .find(|execution| {
                    execution.parent_execution.as_ref() == Some(&workflow.id)
                        && execution.callable.as_ref() == Some(agent)
                })
                .unwrap_or_else(|| panic!("workflow never scheduled {agent}"));
            runtime.drive_execution(&child.id, &mut backend).unwrap();
            recorder.assert_model_tools(model_name, &["bash"]);
        }

        recorder.assert_model_tools("root", &["bash"]);
    }
}
