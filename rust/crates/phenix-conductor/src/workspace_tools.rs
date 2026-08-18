use phenix_conductor::{ConductorError, ConductorRuntime};
use phenix_core::{CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet};
use serde::Deserialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const MAX_CAPTURE_BYTES: usize = 1024 * 1024;
const DEFAULT_READ_LINES: usize = 400;
const MAX_READ_LINES: usize = 2000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BashInput {
    command: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadInput {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteInput {
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrepInput {
    pattern: String,
    path: Option<String>,
    case_sensitive: Option<bool>,
}

pub fn register(runtime: &mut ConductorRuntime, workspace: PathBuf) -> Result<(), ConductorError> {
    let bash_workspace = workspace.clone();
    runtime.register_tool(
        tool_descriptor(
            "bash",
            format!(
                "Execute a Bash command in the current Phenix workspace ({}). Use this for shell commands, builds, tests, and operations not covered by the dedicated workspace tools.",
                workspace.display()
            ),
            json!({
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
            json!({
                "type": "object",
                "required": ["exit_code", "stdout", "stderr"],
                "properties": {
                    "exit_code": { "type": "integer" },
                    "stdout": { "type": "string" },
                    "stderr": { "type": "string" }
                }
            }),
        ),
        move |arguments| execute_bash(&bash_workspace, arguments),
    )?;

    let read_workspace = workspace.clone();
    runtime.register_tool(
        tool_descriptor(
            "read",
            format!(
                "Read a UTF-8 text file from the current Phenix workspace ({}). Paths are workspace-relative. Use offset and limit for large files.",
                workspace.display()
            ),
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path"],
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Workspace-relative file path"
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "1-based first line to return; defaults to 1"
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_READ_LINES,
                        "description": "Maximum number of lines to return; defaults to 400"
                    }
                }
            }),
            json!({
                "type": "object",
                "required": ["path", "content", "start_line", "end_line", "total_lines", "truncated"],
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "start_line": { "type": ["integer", "null"] },
                    "end_line": { "type": ["integer", "null"] },
                    "total_lines": { "type": "integer" },
                    "truncated": { "type": "boolean" }
                }
            }),
        ),
        move |arguments| execute_read(&read_workspace, arguments),
    )?;

    let write_workspace = workspace.clone();
    runtime.register_tool(
        tool_descriptor(
            "write",
            format!(
                "Create or replace a UTF-8 text file in the current Phenix workspace ({}). Paths are workspace-relative and missing parent directories are created.",
                workspace.display()
            ),
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "content"],
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Workspace-relative file path"
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete UTF-8 file contents"
                    }
                }
            }),
            json!({
                "type": "object",
                "required": ["path", "bytes_written"],
                "properties": {
                    "path": { "type": "string" },
                    "bytes_written": { "type": "integer" }
                }
            }),
        ),
        move |arguments| execute_write(&write_workspace, arguments),
    )?;

    runtime.register_tool(
        tool_descriptor(
            "grep",
            format!(
                "Search text recursively in the current Phenix workspace ({}). The pattern uses GNU grep regular-expression syntax; .git is excluded.",
                workspace.display()
            ),
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["pattern"],
                "properties": {
                    "pattern": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Regular expression to search for"
                    },
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Workspace-relative file or directory to search; defaults to ."
                    },
                    "case_sensitive": {
                        "type": "boolean",
                        "description": "Whether matching is case-sensitive; defaults to true"
                    }
                }
            }),
            json!({
                "type": "object",
                "required": ["pattern", "path", "matches", "stderr"],
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string" },
                    "matches": { "type": "string" },
                    "stderr": { "type": "string" }
                }
            }),
        ),
        move |arguments| execute_grep(&workspace, arguments),
    )?;

    Ok(())
}

fn tool_descriptor(
    id: &str,
    description: String,
    input_schema: Value,
    output_schema: Value,
) -> CallableDescriptor {
    CallableDescriptor {
        id: CallableId::parse(id).expect("static callable id"),
        kind: CallableKind::Tool,
        description,
        input_schema,
        output_schema,
        capabilities: CapabilitySet::default(),
        policy: CallablePolicy {
            requires_permission: false,
        },
    }
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

fn execute_read(workspace: &Path, arguments: &str) -> Result<String, String> {
    let input: ReadInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid read arguments: {error}"))?;
    let relative = relative_workspace_path(&input.path)?;
    let path = workspace.join(&relative);
    let offset = input.offset.unwrap_or(1);
    let limit = input.limit.unwrap_or(DEFAULT_READ_LINES);
    if offset == 0 {
        return Err("read offset must be at least 1".to_owned());
    }
    if limit == 0 || limit > MAX_READ_LINES {
        return Err(format!(
            "read limit must be between 1 and {MAX_READ_LINES}"
        ));
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", input.path))?;
    let lines = content.lines().collect::<Vec<_>>();
    let total_lines = lines.len();
    let start_index = offset.saturating_sub(1).min(total_lines);
    let end_index = start_index.saturating_add(limit).min(total_lines);
    let mut selected = lines[start_index..end_index].join("\n");
    if end_index > start_index && (end_index < total_lines || content.ends_with('\n')) {
        selected.push('\n');
    }
    let returned_lines = end_index.saturating_sub(start_index);

    Ok(json!({
        "path": relative.to_string_lossy().into_owned(),
        "content": selected,
        "start_line": (returned_lines > 0).then_some(start_index + 1),
        "end_line": (returned_lines > 0).then_some(end_index),
        "total_lines": total_lines,
        "truncated": end_index < total_lines,
    })
    .to_string())
}

fn execute_write(workspace: &Path, arguments: &str) -> Result<String, String> {
    let input: WriteInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid write arguments: {error}"))?;
    let relative = relative_workspace_path(&input.path)?;
    let path = workspace.join(&relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "failed to create parent directory for {}: {error}",
                input.path
            )
        })?;
    }
    fs::write(&path, input.content.as_bytes())
        .map_err(|error| format!("failed to write {}: {error}", input.path))?;

    Ok(json!({
        "path": relative.to_string_lossy().into_owned(),
        "bytes_written": input.content.len(),
    })
    .to_string())
}

fn execute_grep(workspace: &Path, arguments: &str) -> Result<String, String> {
    let input: GrepInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid grep arguments: {error}"))?;
    if input.pattern.is_empty() {
        return Err("grep pattern must not be empty".to_owned());
    }
    let relative = relative_workspace_path(input.path.as_deref().unwrap_or("."))?;
    let grep = std::env::var_os("PHENIX_GREP").unwrap_or_else(|| OsString::from("grep"));
    let mut command = Command::new(grep);
    command
        .arg("--recursive")
        .arg("--line-number")
        .arg("--with-filename")
        .arg("--binary-files=without-match")
        .arg("--exclude-dir=.git");
    if input.case_sensitive == Some(false) {
        command.arg("--ignore-case");
    }
    let output = command
        .arg("--")
        .arg(&input.pattern)
        .arg(&relative)
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("failed to execute grep: {error}"))?;
    let exit_code = output.status.code().unwrap_or(-1);
    if !matches!(exit_code, 0 | 1) {
        return Err(format!(
            "grep failed with exit code {exit_code}: {}",
            capture(&output.stderr)
        ));
    }

    Ok(json!({
        "pattern": input.pattern,
        "path": relative.to_string_lossy().into_owned(),
        "matches": capture(&output.stdout),
        "stderr": capture(&output.stderr),
    })
    .to_string())
}

fn relative_workspace_path(raw: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("workspace path must not be empty".to_owned());
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(format!("workspace path must be relative: {raw}"));
    }

    let mut relative = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => relative.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("workspace path escapes the workspace: {raw}"));
            }
        }
    }
    if relative.as_os_str().is_empty() {
        relative.push(".");
    }
    Ok(relative)
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
        AgentNode, BackendId, ExecutionId, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
        OrchestrationDefinition, OrchestrationPolicy, ProviderId, RoutingProfile, RoutingProfileId,
    };
    use std::collections::{BTreeMap, BTreeSet};
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

    fn fixture_descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
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

    fn temp_workspace(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!(
            "phenix-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&workspace).unwrap();
        workspace
    }

    #[test]
    fn bash_executes_in_the_bound_workspace() {
        let workspace = temp_workspace("bash-tool");
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
    fn read_and_write_are_workspace_relative_and_line_bounded() {
        let workspace = temp_workspace("file-tools");
        let write = execute_write(
            &workspace,
            r#"{"path":"nested/example.txt","content":"one\ntwo\nthree\n"}"#,
        )
        .unwrap();
        let write: serde_json::Value = serde_json::from_str(&write).unwrap();
        assert_eq!(write["path"], "nested/example.txt");
        assert_eq!(write["bytes_written"], 14);

        let read = execute_read(
            &workspace,
            r#"{"path":"nested/example.txt","offset":2,"limit":1}"#,
        )
        .unwrap();
        let read: serde_json::Value = serde_json::from_str(&read).unwrap();
        assert_eq!(read["content"], "two\n");
        assert_eq!(read["start_line"], 2);
        assert_eq!(read["end_line"], 2);
        assert_eq!(read["total_lines"], 3);
        assert_eq!(read["truncated"], true);

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn dedicated_file_tools_reject_workspace_escape_paths() {
        assert!(relative_workspace_path("../outside").is_err());
        assert!(relative_workspace_path("nested/../../outside").is_err());
        assert!(relative_workspace_path("/absolute").is_err());
        assert_eq!(
            relative_workspace_path("./src/lib.rs").unwrap(),
            Path::new("src/lib.rs")
        );
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
            vec![
                "bash".to_owned(),
                "grep".to_owned(),
                "read".to_owned(),
                "write".to_owned(),
            ]
        );

        let scout = CallableId::parse("agent.scout").unwrap();
        let implementer = CallableId::parse("agent.implementer").unwrap();
        let verifier = CallableId::parse("agent.verifier").unwrap();
        for agent in [&scout, &implementer, &verifier] {
            runtime
                .register_agent(fixture_descriptor(agent.as_str(), CallableKind::Agent))
                .unwrap();
        }

        let workflow_id = CallableId::parse("workflow.tool-surface").unwrap();
        runtime
            .register_orchestration(OrchestrationDefinition {
                descriptor: fixture_descriptor(
                    workflow_id.as_str(),
                    CallableKind::Orchestration,
                ),
                policy: OrchestrationPolicy::Sequential,
                nodes: vec![
                    AgentNode {
                        callable: scout.clone(),
                        objective: Some("inspect the workspace".to_owned()),
                    },
                    AgentNode {
                        callable: implementer.clone(),
                        objective: Some("make the bounded change".to_owned()),
                    },
                    AgentNode {
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
            .start_orchestration(&root.id, &workflow_id, "change and verify")
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
            recorder.assert_model_tools(model_name, &["bash", "grep", "read", "write"]);
        }

        recorder.assert_model_tools("root", &["bash", "grep", "read", "write"]);
    }
}
