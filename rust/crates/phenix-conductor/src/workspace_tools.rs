use super::workspace_consistency::WorkspaceConsistency;
use crate::{ConductorError, ConductorRuntime, ToolOutcome};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet, FileVersion,
    FilesystemAuthority, CAPABILITY_FILESYSTEM_READ, CAPABILITY_FILESYSTEM_WRITE,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeSet;
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
    expected_version: Option<FileVersion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EditInput {
    path: String,
    old_text: String,
    new_text: String,
    replace_all: Option<bool>,
    expected_version: Option<FileVersion>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrepInput {
    pattern: String,
    path: Option<String>,
    case_sensitive: Option<bool>,
}

pub(super) fn register(
    runtime: &mut ConductorRuntime,
    consistency: WorkspaceConsistency,
) -> Result<(), ConductorError> {
    let root = consistency.root().to_path_buf();

    let bash_workspace = root.clone();
    runtime.register_tool(
        tool_descriptor(
            "bash",
            format!(
                "Execute a Bash command in the current Phenix workspace ({}). This tool requires filesystem write authority until shell writes are isolated by the workspace sandbox.",
                root.display()
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
            FilesystemAuthority::Write,
        ),
        move |arguments| execute_bash(&bash_workspace, arguments),
    )?;

    let read_consistency = consistency.clone();
    runtime.register_tool(
        tool_descriptor(
            "read",
            format!(
                "Read a UTF-8 text file from the current Phenix workspace ({}). Source reads return a version token. Pass that exact token to write or edit. Scratch reads return version=null.",
                root.display()
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
                "required": ["path", "content", "start_line", "end_line", "total_lines", "truncated", "version"],
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" },
                    "start_line": { "type": ["integer", "null"] },
                    "end_line": { "type": ["integer", "null"] },
                    "total_lines": { "type": "integer" },
                    "truncated": { "type": "boolean" },
                    "version": nullable_file_version_schema()
                }
            }),
            FilesystemAuthority::ReadOnly,
        ),
        move |arguments| execute_read(&read_consistency, arguments),
    )?;

    let write_consistency = consistency.clone();
    runtime.register_tool(
        tool_descriptor(
            "write",
            format!(
                "Create or replace a UTF-8 text file in the current Phenix workspace ({}). Source writes require expected_version from read. For a new source file use state=absent. Scratch writes omit expected_version.",
                root.display()
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
                    },
                    "expected_version": file_version_schema()
                }
            }),
            json!({
                "type": "object",
                "required": ["path", "bytes_written", "version"],
                "properties": {
                    "path": { "type": "string" },
                    "bytes_written": { "type": "integer" },
                    "version": nullable_file_version_schema()
                }
            }),
            FilesystemAuthority::Write,
        ),
        move |arguments| execute_write(&write_consistency, arguments),
    )?;

    let edit_consistency = consistency.clone();
    runtime.register_tool(
        tool_descriptor(
            "edit",
            format!(
                "Edit a UTF-8 text file in the current Phenix workspace ({}). Source edits require expected_version from read. The old_text match must be unique unless replace_all is true. Scratch edits omit expected_version.",
                root.display()
            ),
            json!({
                "type": "object",
                "additionalProperties": false,
                "required": ["path", "old_text", "new_text"],
                "properties": {
                    "path": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Workspace-relative file path"
                    },
                    "old_text": {
                        "type": "string",
                        "minLength": 1,
                        "description": "Exact text to replace"
                    },
                    "new_text": {
                        "type": "string",
                        "description": "Replacement text"
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every exact match; defaults to false and requires a unique match"
                    },
                    "expected_version": file_version_schema()
                }
            }),
            json!({
                "type": "object",
                "required": ["path", "replacements", "bytes_written", "version"],
                "properties": {
                    "path": { "type": "string" },
                    "replacements": { "type": "integer" },
                    "bytes_written": { "type": "integer" },
                    "version": nullable_file_version_schema()
                }
            }),
            FilesystemAuthority::Write,
        ),
        move |arguments| execute_edit(&edit_consistency, arguments),
    )?;

    runtime.register_tool(
        tool_descriptor(
            "grep",
            format!(
                "Search text recursively in the current Phenix workspace ({}). The pattern uses ripgrep regular-expression syntax. .git is excluded. Grep results are not yet recorded as exact file observations.",
                root.display()
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
                        "description": "Workspace-relative, home-relative, or absolute file/directory path that resolves inside the workspace; defaults to ."
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
            FilesystemAuthority::ReadOnly,
        ),
        move |arguments| execute_grep(&root, arguments),
    )?;

    Ok(())
}

fn tool_descriptor(
    id: &str,
    description: String,
    input_schema: Value,
    output_schema: Value,
    filesystem: FilesystemAuthority,
) -> CallableDescriptor {
    let capability = match filesystem {
        FilesystemAuthority::ReadOnly => CAPABILITY_FILESYSTEM_READ,
        FilesystemAuthority::Write => CAPABILITY_FILESYSTEM_WRITE,
    };
    CallableDescriptor {
        id: CallableId::parse(id).expect("static callable id"),
        kind: CallableKind::Tool,
        description,
        input_schema,
        output_schema,
        capabilities: CapabilitySet(BTreeSet::from([capability.to_owned()])),
        policy: CallablePolicy {
            requires_permission: false,
        },
    }
}

fn file_version_schema() -> Value {
    json!({
        "oneOf": [
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["state"],
                "properties": {
                    "state": { "const": "absent" }
                }
            },
            {
                "type": "object",
                "additionalProperties": false,
                "required": ["state", "content_hash", "kind"],
                "properties": {
                    "state": { "const": "present" },
                    "content_hash": { "type": "string", "minLength": 1 },
                    "kind": {
                        "type": "string",
                        "enum": ["regular", "directory", "symlink", "other"]
                    }
                }
            }
        ]
    })
}

fn nullable_file_version_schema() -> Value {
    json!({
        "anyOf": [
            file_version_schema(),
            { "type": "null" }
        ]
    })
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

fn execute_read(
    consistency: &WorkspaceConsistency,
    arguments: &str,
) -> Result<ToolOutcome, String> {
    let input: ReadInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid read arguments: {error}"))?;
    let offset = input.offset.unwrap_or(1);
    let limit = input.limit.unwrap_or(DEFAULT_READ_LINES);
    if offset == 0 {
        return Err("read offset must be at least 1".to_owned());
    }
    if limit == 0 || limit > MAX_READ_LINES {
        return Err(format!("read limit must be between 1 and {MAX_READ_LINES}"));
    }

    let read = consistency
        .read_utf8(&input.path)
        .map_err(|error| error.to_string())?;
    let lines = read.content.lines().collect::<Vec<_>>();
    let total_lines = lines.len();
    let start_index = offset.saturating_sub(1).min(total_lines);
    let end_index = start_index.saturating_add(limit).min(total_lines);
    let mut selected = lines[start_index..end_index].join("\n");
    if end_index > start_index && (end_index < total_lines || read.content.ends_with('\n')) {
        selected.push('\n');
    }
    let returned_lines = end_index.saturating_sub(start_index);
    let version = read
        .observation
        .as_ref()
        .map(|observation| &observation.version);

    let output = json!({
        "path": read.path.to_string_lossy().into_owned(),
        "content": selected,
        "start_line": (returned_lines > 0).then_some(start_index + 1),
        "end_line": (returned_lines > 0).then_some(end_index),
        "total_lines": total_lines,
        "truncated": end_index < total_lines,
        "version": version,
    })
    .to_string();
    let mut outcome = ToolOutcome::success(output);
    if let Some(observation) = read.observation {
        outcome = outcome.with_file_observation(observation);
    }
    Ok(outcome)
}

fn execute_write(consistency: &WorkspaceConsistency, arguments: &str) -> Result<String, String> {
    let input: WriteInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid write arguments: {error}"))?;
    let relative = relative_workspace_path(&input.path)?;
    let observation = consistency
        .write_utf8(&relative, input.expected_version.as_ref(), &input.content)
        .map_err(|error| error.to_string())?;
    let version = observation.as_ref().map(|observation| &observation.version);

    Ok(json!({
        "path": relative.to_string_lossy().into_owned(),
        "bytes_written": input.content.len(),
        "version": version,
    })
    .to_string())
}

fn execute_edit(consistency: &WorkspaceConsistency, arguments: &str) -> Result<String, String> {
    let input: EditInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid edit arguments: {error}"))?;
    if input.old_text.is_empty() {
        return Err("edit old_text must not be empty".to_owned());
    }
    let read = consistency
        .read_utf8(&input.path)
        .map_err(|error| format!("failed to read {} for edit: {error}", input.path))?;
    let matches = read.content.match_indices(&input.old_text).count();
    if matches == 0 {
        return Err(format!("edit old_text did not match {}", input.path));
    }
    let replace_all = input.replace_all.unwrap_or(false);
    if !replace_all && matches != 1 {
        return Err(format!(
            "edit old_text matched {matches} occurrences in {}; provide more context or set replace_all=true",
            input.path
        ));
    }
    let replacements = if replace_all { matches } else { 1 };
    let updated = if replace_all {
        read.content.replace(&input.old_text, &input.new_text)
    } else {
        read.content.replacen(&input.old_text, &input.new_text, 1)
    };
    let observation = consistency
        .write_utf8(&read.path, input.expected_version.as_ref(), &updated)
        .map_err(|error| error.to_string())?;
    let version = observation.as_ref().map(|observation| &observation.version);

    Ok(json!({
        "path": read.path.to_string_lossy().into_owned(),
        "replacements": replacements,
        "bytes_written": updated.len(),
        "version": version,
    })
    .to_string())
}

fn execute_grep(workspace: &Path, arguments: &str) -> Result<String, String> {
    let input: GrepInput = serde_json::from_str(arguments)
        .map_err(|error| format!("invalid grep arguments: {error}"))?;
    if input.pattern.is_empty() {
        return Err("grep pattern must not be empty".to_owned());
    }
    let relative = search_workspace_path(workspace, input.path.as_deref().unwrap_or("."))?;
    let rg = std::env::var_os("PHENIX_RG").unwrap_or_else(|| OsString::from("rg"));
    let mut command = Command::new(rg);
    command
        .arg("--hidden")
        .arg("--no-ignore")
        .arg("--line-number")
        .arg("--with-filename")
        .arg("--no-heading")
        .arg("--color")
        .arg("never")
        .arg("--glob")
        .arg("!.git/**")
        .arg("--glob")
        .arg("!**/.git/**");
    if input.case_sensitive == Some(false) {
        command.arg("--ignore-case");
    }
    let output = command
        .arg("--")
        .arg(&input.pattern)
        .arg(&relative)
        .current_dir(workspace)
        .output()
        .map_err(|error| format!("failed to execute ripgrep: {error}"))?;
    let exit_code = output.status.code().unwrap_or(-1);
    if !matches!(exit_code, 0 | 1) {
        return Err(format!(
            "ripgrep failed with exit code {exit_code}: {}",
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

fn search_workspace_path(workspace: &Path, raw: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    normalize_search_path(workspace, raw, home.as_deref())
}

fn normalize_search_path(
    workspace: &Path,
    raw: &str,
    home: Option<&Path>,
) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("workspace path must not be empty".to_owned());
    }
    let workspace = fs::canonicalize(workspace).map_err(|error| {
        format!(
            "failed to resolve workspace {}: {error}",
            workspace.display()
        )
    })?;
    let requested = if raw == "~" {
        home.ok_or_else(|| "cannot expand ~ because HOME is not set".to_owned())?
            .to_path_buf()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.ok_or_else(|| "cannot expand ~/ because HOME is not set".to_owned())?
            .join(rest)
    } else {
        PathBuf::from(raw)
    };
    let candidate = if requested.is_absolute() {
        requested
    } else {
        workspace.join(requested)
    };
    let candidate = fs::canonicalize(&candidate)
        .map_err(|error| format!("failed to resolve grep path {raw}: {error}"))?;
    if !candidate.starts_with(&workspace) {
        return Err(format!("grep path escapes workspace: {raw}"));
    }
    let relative = candidate
        .strip_prefix(&workspace)
        .expect("workspace prefix was checked")
        .to_path_buf();
    Ok(if relative.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        relative
    })
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
        return Err("workspace path must name a file".to_owned());
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
        AgentDefinition, BackendId, ExecutionAuthority, ExecutionId, ExecutionTarget,
        FilesystemAuthority, InferenceOptions, ModelId, ModelTarget, OrchestrationDefinition,
        OrchestrationNode, OrchestrationNodeId, ProviderId, RoutingProfile, RoutingProfileId,
        WorkspaceDescriptor, WorkspaceId,
    };
    use std::collections::BTreeMap;
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

    fn orchestration_node(
        id: &str,
        callable: CallableId,
        depends_on: &[&str],
        objective: &str,
    ) -> OrchestrationNode {
        OrchestrationNode {
            id: OrchestrationNodeId::parse(id).unwrap(),
            callable,
            depends_on: depends_on
                .iter()
                .map(|dependency| OrchestrationNodeId::parse(*dependency).unwrap())
                .collect(),
            objective: Some(objective.to_owned()),
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
        let workspace =
            std::env::temp_dir().join(format!("phenix-{label}-{}-{unique}", std::process::id()));
        fs::create_dir_all(&workspace).unwrap();
        workspace
    }

    fn descriptor(root: &Path, scratch_paths: BTreeSet<PathBuf>) -> WorkspaceDescriptor {
        WorkspaceDescriptor {
            id: WorkspaceId::parse("workspace:test").unwrap(),
            root: root.to_path_buf(),
            scratch_paths,
        }
    }

    fn consistency(root: &Path, scratch_paths: BTreeSet<PathBuf>) -> WorkspaceConsistency {
        WorkspaceConsistency::new(&descriptor(root, scratch_paths)).unwrap()
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
        let output: Value = serde_json::from_str(&output).unwrap();
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
        let output: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(output["exit_code"], 7);
        assert_eq!(output["stderr"], "failure");
    }

    #[test]
    fn read_and_write_return_source_versions_and_bound_lines() {
        let workspace = temp_workspace("file-tools");
        let consistency = consistency(&workspace, BTreeSet::new());
        let write = execute_write(
            &consistency,
            r#"{"path":"nested/example.txt","content":"one\ntwo\nthree\n","expected_version":{"state":"absent"}}"#,
        )
        .unwrap();
        let write: Value = serde_json::from_str(&write).unwrap();
        assert_eq!(write["path"], "nested/example.txt");
        assert_eq!(write["bytes_written"], 14);
        assert_eq!(write["version"]["state"], "present");

        let read = execute_read(
            &consistency,
            r#"{"path":"nested/example.txt","offset":2,"limit":1}"#,
        )
        .unwrap();
        assert_eq!(read.file_observations.len(), 1);
        let read: Value = serde_json::from_str(&read.output).unwrap();
        assert_eq!(read["content"], "two\n");
        assert_eq!(read["start_line"], 2);
        assert_eq!(read["end_line"], 2);
        assert_eq!(read["total_lines"], 3);
        assert_eq!(read["truncated"], true);
        assert_eq!(read["version"], write["version"]);

        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn stale_source_write_is_rejected() {
        let workspace = temp_workspace("stale-write");
        fs::write(workspace.join("example.txt"), "v1").unwrap();
        let consistency = consistency(&workspace, BTreeSet::new());
        let read = execute_read(&consistency, r#"{"path":"example.txt"}"#).unwrap();
        let read: Value = serde_json::from_str(&read.output).unwrap();
        fs::write(workspace.join("example.txt"), "external-v2").unwrap();

        let arguments = json!({
            "path": "example.txt",
            "content": "agent-v3",
            "expected_version": read["version"].clone(),
        })
        .to_string();
        let error = execute_write(&consistency, &arguments).unwrap_err();

        assert!(error.contains("changed since it was observed"));
        assert_eq!(
            fs::read_to_string(workspace.join("example.txt")).unwrap(),
            "external-v2"
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn scratch_write_does_not_require_a_source_version() {
        let workspace = temp_workspace("scratch-write");
        let consistency = consistency(&workspace, BTreeSet::from([PathBuf::from("target")]));

        let write = execute_write(
            &consistency,
            r#"{"path":"target/cache.txt","content":"cache"}"#,
        )
        .unwrap();
        let write: Value = serde_json::from_str(&write).unwrap();
        assert_eq!(write["version"], Value::Null);
        assert_eq!(
            fs::read_to_string(workspace.join("target/cache.txt")).unwrap(),
            "cache"
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn edit_requires_a_unique_match_and_the_read_version() {
        let workspace = temp_workspace("edit-tool");
        fs::write(workspace.join("example.txt"), "alpha beta alpha\n").unwrap();
        let consistency = consistency(&workspace, BTreeSet::new());

        let error = execute_edit(
            &consistency,
            r#"{"path":"example.txt","old_text":"alpha","new_text":"omega"}"#,
        )
        .unwrap_err();
        assert!(error.contains("matched 2 occurrences"));

        let read = execute_read(&consistency, r#"{"path":"example.txt"}"#).unwrap();
        let read: Value = serde_json::from_str(&read.output).unwrap();
        let arguments = json!({
            "path": "example.txt",
            "old_text": "alpha",
            "new_text": "omega",
            "replace_all": true,
            "expected_version": read["version"].clone(),
        })
        .to_string();
        let result = execute_edit(&consistency, &arguments).unwrap();
        let result: Value = serde_json::from_str(&result).unwrap();
        assert_eq!(result["replacements"], 2);
        assert_eq!(result["version"]["state"], "present");
        assert_eq!(
            fs::read_to_string(workspace.join("example.txt")).unwrap(),
            "omega beta omega\n"
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn grep_path_normalization_accepts_tilde_and_rejects_escape() {
        let home = temp_workspace("grep-home");
        let workspace = home.join("phenix/repos/phenix-nvim");
        fs::create_dir_all(workspace.join("lua/phenix")).unwrap();
        fs::write(workspace.join("lua/phenix/ui.lua"), "transcript input\n").unwrap();

        assert_eq!(
            normalize_search_path(&workspace, "~/phenix/repos/phenix-nvim/lua", Some(&home),)
                .unwrap(),
            Path::new("lua")
        );
        assert_eq!(
            normalize_search_path(
                &workspace,
                workspace.join("lua").to_str().unwrap(),
                Some(&home)
            )
            .unwrap(),
            Path::new("lua")
        );
        assert!(normalize_search_path(&workspace, "~/outside", Some(&home)).is_err());
        let _ = fs::remove_dir_all(home);
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
    fn workspace_tools_declare_filesystem_requirements() {
        let workspace = temp_workspace("tool-capabilities");
        let mut runtime = ConductorRuntime::new();
        register(&mut runtime, consistency(&workspace, BTreeSet::new())).unwrap();
        let descriptors = runtime
            .tool_descriptors()
            .into_iter()
            .map(|descriptor| (descriptor.id.as_str().to_owned(), descriptor.capabilities))
            .collect::<BTreeMap<_, _>>();

        for id in ["read", "grep"] {
            assert!(descriptors[id].0.contains(CAPABILITY_FILESYSTEM_READ));
        }
        for id in ["bash", "write", "edit"] {
            assert!(descriptors[id].0.contains(CAPABILITY_FILESYSTEM_WRITE));
        }
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn default_tool_registry_reaches_root_and_every_agent_in_an_orchestration() {
        let workspace = temp_workspace("tool-surface");
        let mut runtime = ConductorRuntime::new();
        register(&mut runtime, consistency(&workspace, BTreeSet::new())).unwrap();
        assert_eq!(
            runtime
                .tool_descriptors()
                .into_iter()
                .map(|descriptor| descriptor.id.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec![
                "bash".to_owned(),
                "edit".to_owned(),
                "grep".to_owned(),
                "read".to_owned(),
                "write".to_owned(),
            ]
        );

        let scout = CallableId::parse("agent.scout").unwrap();
        let implementer = CallableId::parse("agent.implementer").unwrap();
        let verifier = CallableId::parse("agent.verifier").unwrap();
        for agent in [&scout, &implementer, &verifier] {
            let mut authority = ExecutionAuthority::read_only();
            authority.filesystem = FilesystemAuthority::Write;
            runtime
                .register_agent(AgentDefinition::new(
                    fixture_descriptor(agent.as_str(), CallableKind::Agent),
                    authority,
                ))
                .unwrap();
        }

        let orchestration_id = CallableId::parse("orchestration.tool-surface").unwrap();
        runtime
            .register_orchestration(OrchestrationDefinition {
                descriptor: fixture_descriptor(
                    orchestration_id.as_str(),
                    CallableKind::Orchestration,
                ),
                nodes: vec![
                    orchestration_node("scout", scout.clone(), &[], "inspect the workspace"),
                    orchestration_node(
                        "implement",
                        implementer.clone(),
                        &["scout"],
                        "make the bounded change",
                    ),
                    orchestration_node(
                        "verify",
                        verifier.clone(),
                        &["implement"],
                        "verify the result",
                    ),
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
            .submit(&session.id, "exercise the orchestration")
            .unwrap();
        let orchestration = runtime
            .start_orchestration(&root.id, &orchestration_id, "change and verify")
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
                    execution.parent_execution.as_ref() == Some(&orchestration.id)
                        && execution.callable.as_ref() == Some(agent)
                })
                .unwrap_or_else(|| panic!("orchestration never scheduled {agent}"));
            runtime.drive_execution(&child.id, &mut backend).unwrap();
            recorder.assert_model_tools(model_name, &["bash", "edit", "grep", "read", "write"]);
        }

        recorder.assert_model_tools("root", &["bash", "edit", "grep", "read", "write"]);
        let _ = fs::remove_dir_all(workspace);
    }
}
