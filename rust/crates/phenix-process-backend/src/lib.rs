#![forbid(unsafe_code)]

use phenix_runtime_api::{
    AgentBackend, AuthFlowId, AuthLink, AuthMethod, AuthNotice, AuthPrompt, AuthPromptOption,
    AuthPromptResponse, AuthProviderSummary, AuthenticationCapabilities, BackendCapabilities,
    BackendCommand, BackendError, BackendEvent, BackendHealth, BackendOutputSender, BackendReply,
    BackendRequest, CommandSource, CommandSummary, DialogId, ExtensionUiCapabilities,
    ExtensionUiRequest, ExtensionUiResponse, ImageInput, ModelCapabilities, ModelRef, ModelSummary,
    NotificationLevel, ObjectiveSummary, PersistedSessionSummary, PersistedSessionTreeSnapshot,
    PromptCapabilities, RequestId, ResourceCapabilities, RunId, RunKind, RunOutcome, RunState,
    RunSummary, SessionCapabilities, SessionEntryId, SessionEntryKind, SessionEntrySummary, SessionId,
    StreamingBehavior, ThinkingLevel, ToolCallId, ToolExecutionOutcome, TranscriptBlock,
    TranscriptRole,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;

const DEFAULT_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const CHILD_POLL_PERIOD: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessBackendConfig {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub cwd: Option<PathBuf>,
    pub max_frame_bytes: usize,
}

impl ProcessBackendConfig {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            arguments: Vec::new(),
            environment: BTreeMap::new(),
            cwd: None,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
        }
    }

    pub fn validate(&self) -> Result<(), BackendError> {
        if self.program.as_os_str().is_empty() {
            return Err(BackendError::InvalidConfiguration(
                "process backend program must not be empty".to_owned(),
            ));
        }
        if self.max_frame_bytes == 0 {
            return Err(BackendError::InvalidConfiguration(
                "process backend frame limit must be positive".to_owned(),
            ));
        }
        Ok(())
    }
}

pub struct ProcessAgentBackend {
    config: ProcessBackendConfig,
}

impl ProcessAgentBackend {
    pub fn new(config: ProcessBackendConfig) -> Result<Self, BackendError> {
        config.validate()?;
        Ok(Self { config })
    }
}

impl AgentBackend for ProcessAgentBackend {
    fn run(
        self: Box<Self>,
        requests: Receiver<BackendRequest>,
        outputs: BackendOutputSender,
    ) -> Result<(), BackendError> {
        let mut command = Command::new(&self.config.program);
        command
            .args(&self.config.arguments)
            .envs(&self.config.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = &self.config.cwd {
            command.current_dir(cwd);
        }
        let mut child = command
            .spawn()
            .map_err(|error| BackendError::Start(error.to_string()))?;
        let mut stdin = child.stdin.take().ok_or_else(|| {
            BackendError::Start("headless runtime stdin was not captured".to_owned())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            BackendError::Start("headless runtime stdout was not captured".to_owned())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            BackendError::Start("headless runtime stderr was not captured".to_owned())
        })?;

        let (driver_sender, driver_inputs) = mpsc::channel();
        spawn_request_forwarder(requests, driver_sender.clone())?;
        spawn_stdout_reader(stdout, self.config.max_frame_bytes, driver_sender.clone())?;
        spawn_stderr_reader(stderr, driver_sender)?;

        let mut pending = HashMap::<RequestId, PendingReply>::new();
        let mut stdout_open = true;
        let mut requests_open = true;
        loop {
            match driver_inputs.recv_timeout(CHILD_POLL_PERIOD) {
                Ok(DriverInput::Request(request)) => {
                    let pending_reply = PendingReply::for_command(&request.command);
                    let frame = request_frame(&request)?;
                    write_json_line(&mut stdin, &frame)?;
                    pending.insert(request.id, pending_reply);
                }
                Ok(DriverInput::RequestsClosed) => {
                    requests_open = false;
                    let _ = child.kill();
                }
                Ok(DriverInput::Frame(frame)) => match frame {
                    WireOutboundFrame::Response { id, result } => {
                        let request_id = RequestId::parse(id)
                            .map_err(|error| BackendError::Protocol(error.to_string()))?;
                        let pending_reply = pending.remove(&request_id).ok_or_else(|| {
                            BackendError::Protocol(format!(
                                "runtime replied to unknown request {request_id}"
                            ))
                        })?;
                        let result = match result {
                            WireResult::Ok { reply } => decode_reply(pending_reply, reply),
                            WireResult::Err { error } => Err(BackendError::Protocol(format!(
                                "{}: {}",
                                error.code, error.message
                            ))),
                        };
                        outputs.reply(request_id, result)?;
                    }
                    WireOutboundFrame::Event { event } => {
                        if let Some(event) = decode_event(event)? {
                            outputs.event(event)?;
                        }
                    }
                },
                Ok(DriverInput::ProtocolFailure(message)) => {
                    return fail_process(
                        &mut child,
                        &outputs,
                        &mut pending,
                        BackendError::Protocol(message),
                    );
                }
                Ok(DriverInput::StdoutClosed) => stdout_open = false,
                Ok(DriverInput::Stderr(line)) => {
                    outputs.event(BackendEvent::Notification {
                        level: NotificationLevel::Warning,
                        message: format!("Pi runtime: {line}"),
                    })?;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    stdout_open = false;
                    requests_open = false;
                }
            }

            if let Some(status) = child
                .try_wait()
                .map_err(|error| BackendError::Transport(error.to_string()))?
            {
                return finish_child(status, &outputs, &mut pending);
            }
            if !stdout_open && !requests_open {
                let status = child
                    .wait()
                    .map_err(|error| BackendError::Transport(error.to_string()))?;
                return finish_child(status, &outputs, &mut pending);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PendingReply {
    Initialize,
    Snapshot,
    Sessions,
    Runs,
    SessionTree,
    Models,
    ThinkingLevels,
    AuthProviders,
    Commands,
    Export,
    Completed,
    Accepted,
}

impl PendingReply {
    fn for_command(command: &BackendCommand) -> Self {
        match command {
            BackendCommand::Initialize { .. } => Self::Initialize,
            BackendCommand::SnapshotRequest => Self::Snapshot,
            BackendCommand::SessionList => Self::Sessions,
            BackendCommand::SessionTree { .. } => Self::SessionTree,
            BackendCommand::ModelList => Self::Models,
            BackendCommand::ThinkingLevels { .. } => Self::ThinkingLevels,
            BackendCommand::AuthProviders => Self::AuthProviders,
            BackendCommand::CommandList => Self::Commands,
            BackendCommand::SessionExport { .. } => Self::Export,
            BackendCommand::Shutdown
            | BackendCommand::ResourceReload
            | BackendCommand::AuthLogout { .. }
            | BackendCommand::CompactionAbort { .. }
            | BackendCommand::RetryAbort { .. } => Self::Completed,
            BackendCommand::PromptSubmit { .. }
            | BackendCommand::PromptSteer { .. }
            | BackendCommand::PromptFollowUp { .. }
            | BackendCommand::ExecutionAbort { .. }
            | BackendCommand::SessionCreate { .. }
            | BackendCommand::SessionSwitch { .. }
            | BackendCommand::SessionFork { .. }
            | BackendCommand::SessionClone { .. }
            | BackendCommand::SessionRename { .. }
            | BackendCommand::ModelSelect { .. }
            | BackendCommand::ThinkingSelect { .. }
            | BackendCommand::AuthLoginStart { .. }
            | BackendCommand::AuthLoginRespond { .. }
            | BackendCommand::AuthLoginCancel { .. }
            | BackendCommand::CompactionStart { .. }
            | BackendCommand::RetryConfigure { .. }
            | BackendCommand::CommandInvoke { .. }
            | BackendCommand::ExtensionUiRespond { .. } => Self::Accepted,
        }
    }
}

#[derive(Debug)]
enum DriverInput {
    Request(BackendRequest),
    RequestsClosed,
    Frame(WireOutboundFrame),
    ProtocolFailure(String),
    StdoutClosed,
    Stderr(String),
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum WireOutboundFrame {
    Response { id: String, result: WireResult },
    Event { event: Value },
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum WireResult {
    Ok {
        ok: True,
        reply: Value,
    },
    Err {
        ok: False,
        error: WireError,
    },
}

#[derive(Debug, Deserialize)]
struct WireError {
    code: String,
    message: String,
    #[allow(dead_code)]
    retryable: bool,
}

#[derive(Debug, Deserialize)]
struct True;

#[derive(Debug, Deserialize)]
struct False;

fn spawn_request_forwarder(
    requests: Receiver<BackendRequest>,
    sender: Sender<DriverInput>,
) -> Result<(), BackendError> {
    thread::Builder::new()
        .name("phenix-process-requests".to_owned())
        .spawn(move || {
            for request in requests {
                if sender.send(DriverInput::Request(request)).is_err() {
                    return;
                }
            }
            let _ = sender.send(DriverInput::RequestsClosed);
        })
        .map(|_| ())
        .map_err(|error| BackendError::Start(error.to_string()))
}

fn spawn_stdout_reader(
    stdout: ChildStdout,
    max_frame_bytes: usize,
    sender: Sender<DriverInput>,
) -> Result<(), BackendError> {
    thread::Builder::new()
        .name("phenix-process-stdout".to_owned())
        .spawn(move || read_stdout(stdout, max_frame_bytes, sender))
        .map(|_| ())
        .map_err(|error| BackendError::Start(error.to_string()))
}

fn read_stdout(stdout: ChildStdout, max_frame_bytes: usize, sender: Sender<DriverInput>) {
    let mut reader = BufReader::new(stdout);
    let mut frame = Vec::new();
    loop {
        frame.clear();
        match reader.read_until(b'\n', &mut frame) {
            Ok(0) => {
                let _ = sender.send(DriverInput::StdoutClosed);
                return;
            }
            Ok(_) if frame.len() > max_frame_bytes => {
                let _ = sender.send(DriverInput::ProtocolFailure(format!(
                    "runtime JSONL frame exceeds {max_frame_bytes} bytes"
                )));
                return;
            }
            Ok(_) => {
                while matches!(frame.last(), Some(b'\n' | b'\r')) {
                    frame.pop();
                }
                if frame.is_empty() {
                    continue;
                }
                match serde_json::from_slice::<WireOutboundFrame>(&frame) {
                    Ok(decoded) => {
                        if sender.send(DriverInput::Frame(decoded)).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(DriverInput::ProtocolFailure(error.to_string()));
                        return;
                    }
                }
            }
            Err(error) => {
                let _ = sender.send(DriverInput::ProtocolFailure(error.to_string()));
                return;
            }
        }
    }
}

fn spawn_stderr_reader(stderr: ChildStderr, sender: Sender<DriverInput>) -> Result<(), BackendError> {
    thread::Builder::new()
        .name("phenix-process-stderr".to_owned())
        .spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let line = match line {
                    Ok(line) => line,
                    Err(error) => {
                        let _ = sender.send(DriverInput::Stderr(error.to_string()));
                        return;
                    }
                };
                if sender.send(DriverInput::Stderr(line)).is_err() {
                    return;
                }
            }
        })
        .map(|_| ())
        .map_err(|error| BackendError::Start(error.to_string()))
}

fn request_frame(request: &BackendRequest) -> Result<Value, BackendError> {
    Ok(json!({
        "kind": "request",
        "id": request.id.as_str(),
        "command": command_value(&request.command)?,
    }))
}

fn command_value(command: &BackendCommand) -> Result<Value, BackendError> {
    let value = match command {
        BackendCommand::Initialize { client } => json!({
            "type": "initialize",
            "client": { "name": client.name, "build": client.build },
        }),
        BackendCommand::SnapshotRequest => json!({ "type": "snapshot.request" }),
        BackendCommand::PromptSubmit {
            run_id,
            text,
            images,
            streaming_behavior,
        } => json!({
            "type": "prompt.submit",
            "runId": run_id.as_str(),
            "text": text,
            "images": image_values(images),
            "streamingBehavior": streaming_behavior.as_ref().map(streaming_behavior_value),
        }),
        BackendCommand::PromptSteer {
            run_id,
            text,
            images,
        } => json!({
            "type": "prompt.steer",
            "runId": run_id.as_str(),
            "text": text,
            "images": image_values(images),
        }),
        BackendCommand::PromptFollowUp {
            run_id,
            text,
            images,
        } => json!({
            "type": "prompt.follow_up",
            "runId": run_id.as_str(),
            "text": text,
            "images": image_values(images),
        }),
        BackendCommand::ExecutionAbort { run_id } => json!({
            "type": "execution.abort",
            "runId": run_id.as_ref().map(RunId::as_str),
        }),
        BackendCommand::SessionCreate { parent_session } => json!({
            "type": "session.create",
            "parentSession": parent_session.as_ref().map(SessionId::as_str),
        }),
        BackendCommand::SessionSwitch { session_id } => json!({
            "type": "session.switch",
            "sessionId": session_id.as_str(),
        }),
        BackendCommand::SessionFork {
            session_id,
            entry_id,
        } => json!({
            "type": "session.fork",
            "sessionId": session_id.as_str(),
            "entryId": entry_id.as_str(),
        }),
        BackendCommand::SessionClone { session_id } => json!({
            "type": "session.clone",
            "sessionId": session_id.as_str(),
        }),
        BackendCommand::SessionRename { session_id, name } => json!({
            "type": "session.rename",
            "sessionId": session_id.as_str(),
            "name": name,
        }),
        BackendCommand::SessionList => json!({ "type": "session.list" }),
        BackendCommand::SessionTree { session_id } => json!({
            "type": "session.tree",
            "sessionId": session_id.as_str(),
        }),
        BackendCommand::SessionExport { session_id, path } => json!({
            "type": "session.export",
            "sessionId": session_id.as_str(),
            "path": path,
        }),
        BackendCommand::ModelList => json!({ "type": "model.list" }),
        BackendCommand::ModelSelect { run_id, model } => json!({
            "type": "model.select",
            "runId": run_id.as_str(),
            "model": model_value(model),
        }),
        BackendCommand::ThinkingLevels { run_id } => json!({
            "type": "thinking.levels",
            "runId": run_id.as_str(),
        }),
        BackendCommand::ThinkingSelect { run_id, level } => json!({
            "type": "thinking.select",
            "runId": run_id.as_str(),
            "level": thinking_level_value(level),
        }),
        BackendCommand::AuthProviders => json!({ "type": "auth.providers" }),
        BackendCommand::AuthLoginStart {
            provider_id,
            method,
        } => json!({
            "type": "auth.login.start",
            "providerId": provider_id,
            "method": auth_method_value(method),
        }),
        BackendCommand::AuthLoginRespond { flow_id, response } => json!({
            "type": "auth.login.respond",
            "flowId": flow_id.as_str(),
            "response": auth_response_value(response)?,
        }),
        BackendCommand::AuthLoginCancel { flow_id } => json!({
            "type": "auth.login.cancel",
            "flowId": flow_id.as_str(),
        }),
        BackendCommand::AuthLogout { provider_id } => json!({
            "type": "auth.logout",
            "providerId": provider_id,
        }),
        BackendCommand::CompactionStart {
            run_id,
            instructions,
        } => json!({
            "type": "compaction.start",
            "runId": run_id.as_str(),
            "instructions": instructions,
        }),
        BackendCommand::CompactionAbort { run_id } => json!({
            "type": "compaction.abort",
            "runId": run_id.as_str(),
        }),
        BackendCommand::RetryConfigure { run_id, enabled } => json!({
            "type": "retry.configure",
            "runId": run_id.as_str(),
            "enabled": enabled,
        }),
        BackendCommand::RetryAbort { run_id } => json!({
            "type": "retry.abort",
            "runId": run_id.as_str(),
        }),
        BackendCommand::CommandList => json!({ "type": "command.list" }),
        BackendCommand::CommandInvoke {
            run_id,
            name,
            arguments,
        } => json!({
            "type": "command.invoke",
            "runId": run_id.as_str(),
            "name": name,
            "arguments": arguments,
        }),
        BackendCommand::ResourceReload => json!({ "type": "resource.reload" }),
        BackendCommand::ExtensionUiRespond {
            dialog_id,
            response,
        } => json!({
            "type": "extension_ui.respond",
            "dialogId": dialog_id.as_str(),
            "response": extension_response_value(response),
        }),
        BackendCommand::Shutdown => json!({ "type": "shutdown" }),
    };
    Ok(value)
}

fn image_values(images: &[ImageInput]) -> Vec<Value> {
    images
        .iter()
        .map(|image| {
            json!({
                "mediaType": image.media_type,
                "data": encode_base64(&image.bytes),
            })
        })
        .collect()
}

fn model_value(model: &ModelRef) -> Value {
    json!({ "provider": model.provider, "model": model.model })
}

fn streaming_behavior_value(behavior: &StreamingBehavior) -> &'static str {
    match behavior {
        StreamingBehavior::Steer => "steer",
        StreamingBehavior::FollowUp => "follow_up",
    }
}

fn thinking_level_value(level: &ThinkingLevel) -> &'static str {
    match level {
        ThinkingLevel::Off => "off",
        ThinkingLevel::Minimal => "minimal",
        ThinkingLevel::Low => "low",
        ThinkingLevel::Medium => "medium",
        ThinkingLevel::High => "high",
        ThinkingLevel::ExtraHigh => "xhigh",
        ThinkingLevel::Max => "max",
    }
}

fn auth_method_value(method: &AuthMethod) -> &'static str {
    match method {
        AuthMethod::OAuth => "oauth",
        AuthMethod::ApiKey => "api_key",
    }
}

fn auth_response_value(response: &AuthPromptResponse) -> Result<Value, BackendError> {
    Ok(match response {
        AuthPromptResponse::Text(value) => json!({ "kind": "text", "value": value }),
        AuthPromptResponse::Secret(value) => json!({
            "kind": "secret",
            "value": value
                .expose()
                .map_err(|error| BackendError::Protocol(error.to_string()))?,
        }),
        AuthPromptResponse::Selected(value) => {
            json!({ "kind": "selected", "value": value })
        }
        AuthPromptResponse::ManualCode(value) => {
            json!({ "kind": "manual_code", "value": value })
        }
        AuthPromptResponse::Cancelled => json!({ "kind": "cancelled" }),
    })
}

fn extension_response_value(response: &ExtensionUiResponse) -> Value {
    match response {
        ExtensionUiResponse::Selected(value) => {
            json!({ "kind": "selected", "value": value })
        }
        ExtensionUiResponse::Confirmed(value) => {
            json!({ "kind": "confirmed", "value": value })
        }
        ExtensionUiResponse::Text(value) => json!({ "kind": "text", "value": value }),
        ExtensionUiResponse::Cancelled => json!({ "kind": "cancelled" }),
    }
}

fn write_json_line(writer: &mut impl Write, frame: &Value) -> Result<(), BackendError> {
    serde_json::to_writer(&mut *writer, frame)
        .map_err(|error| BackendError::Protocol(error.to_string()))?;
    writer
        .write_all(b"\n")
        .and_then(|()| writer.flush())
        .map_err(|error| BackendError::Transport(error.to_string()))
}

fn decode_reply(kind: PendingReply, value: Value) -> Result<BackendReply, BackendError> {
    match kind {
        PendingReply::Initialize => {
            let object = object(&value, "initialize reply")?;
            let capabilities = decode_capabilities(object.get("capabilities").unwrap_or(&Value::Null));
            let mut snapshot = decode_snapshot(object.get("snapshot").unwrap_or(&Value::Null))?;
            snapshot.capabilities = capabilities.clone();
            Ok(BackendReply::Initialized {
                capabilities,
                snapshot,
            })
        }
        PendingReply::Snapshot => Ok(BackendReply::Snapshot(decode_snapshot(&value)?)),
        PendingReply::Sessions => Ok(BackendReply::Sessions(decode_sessions(&value)?)),
        PendingReply::Runs => Ok(BackendReply::Runs(decode_runs(&value)?)),
        PendingReply::SessionTree => Ok(BackendReply::SessionTree(decode_session_tree(&value)?)),
        PendingReply::Models => Ok(BackendReply::Models(decode_models(&value)?)),
        PendingReply::ThinkingLevels => {
            Ok(BackendReply::ThinkingLevels(decode_thinking_levels(&value)?))
        }
        PendingReply::AuthProviders => {
            Ok(BackendReply::AuthProviders(decode_auth_providers(&value)?))
        }
        PendingReply::Commands => Ok(BackendReply::Commands(decode_commands(&value)?)),
        PendingReply::Export => Ok(BackendReply::Exported {
            path: string_field(object(&value, "export reply")?, "path")?.to_owned(),
        }),
        PendingReply::Completed => Ok(BackendReply::Completed),
        PendingReply::Accepted => Ok(BackendReply::Accepted),
    }
}

fn decode_snapshot(value: &Value) -> Result<phenix_runtime_api::RuntimeSnapshot, BackendError> {
    let object = object(value, "runtime snapshot")?;
    let capabilities = decode_capabilities(object.get("capabilities").unwrap_or(&Value::Null));
    let health = decode_health(object.get("health"));
    let active_session = object
        .get("activeSession")
        .and_then(session_id_from_value)
        .transpose()?;
    let root_run = optional_id(object.get("rootRunId"), RunId::parse)?;
    let selected_run = optional_id(object.get("selectedRunId"), RunId::parse)?;
    let mut sessions = object
        .get("sessions")
        .map_or_else(|| Ok(Vec::new()), decode_sessions)?;
    if sessions.is_empty() {
        if let Some(active) = object.get("activeSession") {
            if active.is_object() {
                sessions.push(decode_session(active)?);
            }
        }
    }
    let runs = if let Some(runs) = object.get("runs") {
        decode_runs(runs)?
    } else {
        object
            .get("workspace")
            .and_then(|workspace| workspace.get("tree"))
            .map_or_else(|| Ok(Vec::new()), decode_runs)?
    };
    let objectives = object
        .get("objectives")
        .map_or_else(|| Ok(Vec::new()), decode_objectives)?;
    Ok(phenix_runtime_api::RuntimeSnapshot {
        capabilities,
        health,
        active_session,
        root_run,
        selected_run,
        sessions,
        runs,
        objectives,
    })
}

fn decode_capabilities(value: &Value) -> BackendCapabilities {
    BackendCapabilities {
        prompting: PromptCapabilities {
            steering: bool_path(value, &["prompting", "steering"]),
            follow_ups: bool_path(value, &["prompting", "followUps"]),
            images: bool_path(value, &["prompting", "images"]),
            compaction: bool_path(value, &["prompting", "compaction"]),
            retry_control: bool_path(value, &["prompting", "retryControl"]),
        },
        sessions: SessionCapabilities {
            persistence: bool_path(value, &["sessions", "persistence"]),
            switching: bool_path(value, &["sessions", "switching"]),
            branching: bool_path(value, &["sessions", "branching"]),
            import: bool_path(value, &["sessions", "import"]),
            export: bool_path(value, &["sessions", "export"]),
            tree: bool_path(value, &["sessions", "tree"]),
        },
        authentication: AuthenticationCapabilities {
            provider_listing: bool_path(value, &["authentication", "providerListing"]),
            oauth: bool_path(value, &["authentication", "oauth"]),
            api_keys: bool_path(value, &["authentication", "apiKeys"]),
            device_code: bool_path(value, &["authentication", "deviceCode"]),
            browser_callback: bool_path(value, &["authentication", "browserCallback"]),
            logout: bool_path(value, &["authentication", "logout"]),
        },
        models: ModelCapabilities {
            listing: bool_path(value, &["models", "listing"]),
            selection: bool_path(value, &["models", "selection"]),
            thinking_levels: bool_path(value, &["models", "thinkingLevels"]),
            virtual_models: bool_path(value, &["models", "virtualModels"]),
        },
        resources: ResourceCapabilities {
            commands: bool_path(value, &["resources", "commands"]),
            extensions: bool_path(value, &["resources", "extensions"]),
            skills: bool_path(value, &["resources", "skills"]),
            prompt_templates: bool_path(value, &["resources", "promptTemplates"]),
            reload: bool_path(value, &["resources", "reload"]),
        },
        extension_ui: ExtensionUiCapabilities {
            selection: bool_path(value, &["extensionUi", "selection"]),
            confirmation: bool_path(value, &["extensionUi", "confirmation"]),
            text_input: bool_path(value, &["extensionUi", "textInput"]),
            secret_input: bool_path(value, &["extensionUi", "secretInput"]),
            editor: bool_path(value, &["extensionUi", "editor"]),
            notifications: bool_path(value, &["extensionUi", "notifications"]),
            status: bool_path(value, &["extensionUi", "status"]),
        },
    }
}

fn decode_health(value: Option<&Value>) -> BackendHealth {
    match value.and_then(Value::as_str) {
        Some("starting") => BackendHealth::Starting,
        Some("ready") => BackendHealth::Ready,
        Some("stopped") => BackendHealth::Stopped,
        Some("degraded") => BackendHealth::Degraded {
            message: "Runtime is degraded".to_owned(),
        },
        Some("failed") => BackendHealth::Failed {
            message: "Runtime failed".to_owned(),
        },
        _ => BackendHealth::Starting,
    }
}

fn decode_sessions(value: &Value) -> Result<Vec<PersistedSessionSummary>, BackendError> {
    array(value, "sessions")?
        .iter()
        .map(decode_session)
        .collect()
}

fn decode_session(value: &Value) -> Result<PersistedSessionSummary, BackendError> {
    let object = object(value, "persisted session")?;
    Ok(PersistedSessionSummary {
        id: SessionId::parse(string_field(object, "id")?)
            .map_err(|error| BackendError::Protocol(error.to_string()))?,
        name: optional_string(object.get("name")),
        session_file: optional_string(object.get("path").or_else(|| object.get("file"))),
        cwd: optional_string(object.get("cwd")),
        root_run_id: optional_id(object.get("rootRunId"), RunId::parse)?,
        updated_at: optional_string(object.get("updatedAt")),
    })
}

fn decode_runs(value: &Value) -> Result<Vec<RunSummary>, BackendError> {
    if let Some(array) = value.as_array() {
        return array.iter().map(decode_run).collect();
    }
    let root = value.get("root").unwrap_or(value);
    let mut runs = Vec::new();
    decode_run_node(root, &mut runs)?;
    Ok(runs)
}

fn decode_run_node(value: &Value, runs: &mut Vec<RunSummary>) -> Result<(), BackendError> {
    let run_value = value.get("run").unwrap_or(value);
    runs.push(decode_run(run_value)?);
    if let Some(children) = value.get("children").and_then(Value::as_array) {
        for child in children {
            decode_run_node(child, runs)?;
        }
    }
    Ok(())
}

fn decode_run(value: &Value) -> Result<RunSummary, BackendError> {
    let object = object(value, "run")?;
    let id = RunId::parse(string_field(object, "id")?)
        .map_err(|error| BackendError::Protocol(error.to_string()))?;
    let definition_id = object
        .get("definitionId")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let profile = object.get("profile").and_then(Value::as_object);
    let resolved_model = object.get("resolvedModel").and_then(Value::as_object);
    Ok(RunSummary {
        id,
        parent: optional_id(object.get("parentId"), RunId::parse)?,
        kind: parse_run_kind(object.get("kind").and_then(Value::as_str)),
        display_name: definition_id.clone(),
        definition_id,
        state: parse_run_state(object.get("state").and_then(Value::as_str)),
        persisted_session: object
            .get("pi")
            .and_then(|pi| pi.get("sessionId"))
            .and_then(Value::as_str)
            .map(SessionId::parse)
            .transpose()
            .map_err(|error| BackendError::Protocol(error.to_string()))?,
        session_file: object
            .get("pi")
            .and_then(|pi| pi.get("sessionFile"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        model: resolved_model.and_then(|model| {
            let provider = model.get("provider")?.as_str()?;
            let model = model
                .get("model")
                .or_else(|| model.get("modelId"))?
                .as_str()?;
            Some(ModelRef {
                provider: provider.to_owned(),
                model: model.to_owned(),
            })
        }),
        thinking_level: profile
            .and_then(|profile| profile.get("thinkingLevel"))
            .and_then(Value::as_str)
            .and_then(parse_thinking_level),
        difficulty: profile
            .and_then(|profile| profile.get("difficulty"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        budget: profile
            .and_then(|profile| profile.get("budget"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        pending_messages: 0,
        outcome: decode_outcome(object.get("outcome")),
    })
}

fn decode_outcome(value: Option<&Value>) -> Option<RunOutcome> {
    let object = value?.as_object()?;
    let kind = object.get("kind").and_then(Value::as_str)?;
    match kind {
        "success" => Some(RunOutcome::Success),
        "failure" => Some(RunOutcome::Failure {
            code: object
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("failure")
                .to_owned(),
            message: object
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Run failed")
                .to_owned(),
            retryable: object
                .get("error")
                .and_then(|error| error.get("retryable"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "cancelled" => Some(RunOutcome::Cancelled {
            reason: object
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("Cancelled")
                .to_owned(),
        }),
        _ => None,
    }
}

fn decode_objectives(value: &Value) -> Result<Vec<ObjectiveSummary>, BackendError> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    Err(BackendError::Unsupported(
        "objective wire projection is not available yet".to_owned(),
    ))
}

fn decode_session_tree(value: &Value) -> Result<PersistedSessionTreeSnapshot, BackendError> {
    let object = object(value, "session tree")?;
    let session_id = SessionId::parse(string_field(object, "sessionId")?)
        .map_err(|error| BackendError::Protocol(error.to_string()))?;
    let leaf_entry = optional_id(object.get("leafEntryId"), SessionEntryId::parse)?;
    let entries_value = object.get("tree").or_else(|| object.get("entries"));
    let entries = entries_value
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |entries| {
            entries.iter().filter_map(decode_session_entry).collect()
        });
    Ok(PersistedSessionTreeSnapshot {
        session_id,
        leaf_entry,
        entries,
    })
}

fn decode_session_entry(value: &Value) -> Option<SessionEntrySummary> {
    let object = value.as_object()?;
    let id = SessionEntryId::parse(object.get("id")?.as_str()?).ok()?;
    let parent = object
        .get("parentId")
        .and_then(Value::as_str)
        .and_then(|value| SessionEntryId::parse(value).ok());
    let kind = match object.get("type").and_then(Value::as_str) {
        Some("message") => match object
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(Value::as_str)
        {
            Some("user") => SessionEntryKind::User,
            Some("assistant") => SessionEntryKind::Assistant,
            Some("toolResult") => SessionEntryKind::Tool,
            _ => SessionEntryKind::Other,
        },
        Some("compaction") => SessionEntryKind::Compaction,
        Some("model_change") => SessionEntryKind::ModelChange,
        Some("thinking_level_change") => SessionEntryKind::ThinkingChange,
        _ => SessionEntryKind::Other,
    };
    Some(SessionEntrySummary {
        id,
        parent,
        kind,
        label: optional_string(object.get("label")),
    })
}

fn decode_models(value: &Value) -> Result<Vec<ModelSummary>, BackendError> {
    array(value, "models")?
        .iter()
        .map(|value| {
            let object = object(value, "model")?;
            let provider = string_field(object, "provider")?.to_owned();
            let model = string_field(object, "model")?.to_owned();
            let input = object.get("input").and_then(Value::as_array);
            Ok(ModelSummary {
                model: ModelRef { provider, model },
                display_name: object
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| object.get("model").and_then(Value::as_str).unwrap_or("model"))
                    .to_owned(),
                supports_images: input.is_some_and(|input| {
                    input.iter().any(|kind| kind.as_str() == Some("image"))
                }),
                supports_thinking: object
                    .get("reasoning")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn decode_thinking_levels(value: &Value) -> Result<Vec<ThinkingLevel>, BackendError> {
    array(value, "thinking levels")?
        .iter()
        .map(|level| {
            level
                .as_str()
                .and_then(parse_thinking_level)
                .ok_or_else(|| BackendError::Protocol("unknown thinking level".to_owned()))
        })
        .collect()
}

fn decode_auth_providers(value: &Value) -> Result<Vec<AuthProviderSummary>, BackendError> {
    array(value, "authentication providers")?
        .iter()
        .map(|value| {
            let object = object(value, "authentication provider")?;
            let methods = object
                .get("methods")
                .and_then(Value::as_array)
                .map_or_else(Vec::new, |methods| {
                    methods
                        .iter()
                        .filter_map(|method| match method.as_str() {
                            Some("oauth") => Some(AuthMethod::OAuth),
                            Some("api_key") => Some(AuthMethod::ApiKey),
                            _ => None,
                        })
                        .collect()
                });
            Ok(AuthProviderSummary {
                id: string_field(object, "id")?.to_owned(),
                display_name: object
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| object.get("id").and_then(Value::as_str).unwrap_or("provider"))
                    .to_owned(),
                methods,
                configured: object
                    .get("configured")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                source: optional_string(object.get("source")),
            })
        })
        .collect()
}

fn decode_commands(value: &Value) -> Result<Vec<CommandSummary>, BackendError> {
    array(value, "commands")?
        .iter()
        .map(|value| {
            let object = object(value, "command")?;
            Ok(CommandSummary {
                name: string_field(object, "name")?.to_owned(),
                description: optional_string(object.get("description")),
                source: match object.get("source").and_then(Value::as_str) {
                    Some("extension") => CommandSource::Extension,
                    Some("skill") => CommandSource::Skill,
                    Some("prompt") | Some("prompt_template") => CommandSource::PromptTemplate,
                    _ => CommandSource::BuiltIn,
                },
            })
        })
        .collect()
}

fn decode_event(value: Value) -> Result<Option<BackendEvent>, BackendError> {
    let object = object(&value, "runtime event")?;
    let event_type = string_field(object, "type")?;
    let event = match event_type {
        "snapshot.changed" => Some(BackendEvent::SnapshotChanged(decode_snapshot(
            object.get("snapshot").unwrap_or(&Value::Null),
        )?)),
        "transcript.appended" => Some(BackendEvent::TranscriptAppended(decode_transcript_block(
            object.get("block").unwrap_or(&Value::Null),
        )?)),
        "transcript.updated" => Some(BackendEvent::TranscriptUpdated(decode_transcript_block(
            object.get("block").unwrap_or(&Value::Null),
        )?)),
        "tool.started" => Some(BackendEvent::ToolStarted {
            run_id: parse_run_id_field(object, "runId")?,
            tool_call_id: parse_tool_call_id_field(object, "toolCallId")?,
            tool_name: string_field(object, "toolName")?.to_owned(),
            input_summary: string_field(object, "inputSummary")?.to_owned(),
        }),
        "tool.updated" => Some(BackendEvent::ToolUpdated {
            run_id: parse_run_id_field(object, "runId")?,
            tool_call_id: parse_tool_call_id_field(object, "toolCallId")?,
            output: string_field(object, "output")?.to_owned(),
        }),
        "tool.finished" => Some(BackendEvent::ToolFinished {
            run_id: parse_run_id_field(object, "runId")?,
            tool_call_id: parse_tool_call_id_field(object, "toolCallId")?,
            outcome: match object.get("outcome").and_then(Value::as_str) {
                Some("succeeded") => ToolExecutionOutcome::Succeeded,
                Some("failed") => ToolExecutionOutcome::Failed,
                _ => ToolExecutionOutcome::Aborted,
            },
            output_summary: string_field(object, "outputSummary")?.to_owned(),
        }),
        "queue.changed" => Some(BackendEvent::QueueChanged {
            run_id: parse_run_id_field(object, "runId")?,
            steering: string_array(object.get("steering")),
            follow_ups: string_array(object.get("followUps")),
        }),
        "auth.prompt.requested" => Some(BackendEvent::AuthPromptRequested {
            flow_id: parse_auth_flow_id_field(object, "flowId")?,
            prompt: decode_auth_prompt(object.get("prompt").unwrap_or(&Value::Null))?,
        }),
        "auth.notice" => Some(BackendEvent::AuthNotice {
            flow_id: parse_auth_flow_id_field(object, "flowId")?,
            notice: decode_auth_notice(object.get("notice").unwrap_or(&Value::Null))?,
        }),
        "auth.finished" => Some(decode_auth_finished(object)?),
        "extension_ui.requested" => Some(BackendEvent::ExtensionUiRequested {
            dialog_id: DialogId::parse(string_field(object, "dialogId")?)
                .map_err(|error| BackendError::Protocol(error.to_string()))?,
            request: decode_extension_request(object.get("request").unwrap_or(&Value::Null))?,
        }),
        "notification" => Some(BackendEvent::Notification {
            level: match object.get("level").and_then(Value::as_str) {
                Some("error") => NotificationLevel::Error,
                Some("warning") => NotificationLevel::Warning,
                _ => NotificationLevel::Information,
            },
            message: string_field(object, "message")?.to_owned(),
        }),
        "status.changed" => Some(BackendEvent::StatusChanged {
            key: string_field(object, "key")?.to_owned(),
            text: optional_string(object.get("text")),
        }),
        "runtime.health" => Some(BackendEvent::HealthChanged(match object
            .get("health")
            .and_then(Value::as_str)
        {
            Some("ready") => BackendHealth::Ready,
            Some("stopped") => BackendHealth::Stopped,
            Some("failed") => BackendHealth::Failed {
                message: optional_string(object.get("message"))
                    .unwrap_or_else(|| "Runtime failed".to_owned()),
            },
            Some("degraded") => BackendHealth::Degraded {
                message: optional_string(object.get("message"))
                    .unwrap_or_else(|| "Runtime degraded".to_owned()),
            },
            _ => BackendHealth::Starting,
        })),
        "protocol.error" | "extension.error" | "runtime.diagnostic" => {
            Some(BackendEvent::Notification {
                level: if event_type == "runtime.diagnostic"
                    && object.get("level").and_then(Value::as_str) == Some("info")
                {
                    NotificationLevel::Information
                } else {
                    NotificationLevel::Warning
                },
                message: event_message(object),
            })
        }
        "agent.started" => Some(BackendEvent::StatusChanged {
            key: "agent".to_owned(),
            text: Some("running".to_owned()),
        }),
        "agent.ended" | "agent.settled" => Some(BackendEvent::StatusChanged {
            key: "agent".to_owned(),
            text: None,
        }),
        "compaction.changed" | "retry.changed" | "thinking.changed" => {
            Some(BackendEvent::StatusChanged {
                key: event_type.to_owned(),
                text: Some(event_message(object)),
            })
        }
        "extension_ui.cancelled"
        | "auth.prompt.cancelled"
        | "session.info_changed"
        | "widget.changed"
        | "working.message"
        | "working.visibility"
        | "working.indicator"
        | "thinking.hidden_label"
        | "terminal.title"
        | "editor.replace"
        | "editor.paste"
        | "tools.expanded"
        | "extension_ui.unsupported" => None,
        _ => {
            return Err(BackendError::Protocol(format!(
                "unknown runtime event type {event_type}"
            )))
        }
    };
    Ok(event)
}

fn decode_transcript_block(value: &Value) -> Result<TranscriptBlock, BackendError> {
    let object = object(value, "transcript block")?;
    Ok(TranscriptBlock {
        id: string_field(object, "id")?.to_owned(),
        run_id: parse_run_id_field(object, "runId")?,
        role: match object.get("role").and_then(Value::as_str) {
            Some("user") => TranscriptRole::User,
            Some("assistant") => TranscriptRole::Assistant,
            Some("thinking") => TranscriptRole::Thinking,
            Some("tool") => TranscriptRole::Tool,
            _ => TranscriptRole::System,
        },
        text: string_field(object, "text")?.to_owned(),
        complete: object
            .get("complete")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn decode_auth_prompt(value: &Value) -> Result<AuthPrompt, BackendError> {
    let object = object(value, "authentication prompt")?;
    let message = string_field(object, "message")?.to_owned();
    let placeholder = optional_string(object.get("placeholder"));
    match string_field(object, "kind")? {
        "text" => Ok(AuthPrompt::Text {
            message,
            placeholder,
        }),
        "secret" => Ok(AuthPrompt::Secret {
            message,
            placeholder,
        }),
        "manual_code" => Ok(AuthPrompt::ManualCode {
            message,
            placeholder,
        }),
        "select" => Ok(AuthPrompt::Select {
            message,
            options: object
                .get("options")
                .and_then(Value::as_array)
                .map_or_else(Vec::new, |options| {
                    options
                        .iter()
                        .filter_map(|option| {
                            let option = option.as_object()?;
                            Some(AuthPromptOption {
                                id: option.get("id")?.as_str()?.to_owned(),
                                label: option.get("label")?.as_str()?.to_owned(),
                                description: optional_string(option.get("description")),
                            })
                        })
                        .collect()
                }),
        }),
        kind => Err(BackendError::Protocol(format!(
            "unknown authentication prompt kind {kind}"
        ))),
    }
}

fn decode_auth_notice(value: &Value) -> Result<AuthNotice, BackendError> {
    let object = object(value, "authentication notice")?;
    match string_field(object, "kind")? {
        "information" => Ok(AuthNotice::Information {
            message: string_field(object, "message")?.to_owned(),
            links: object
                .get("links")
                .and_then(Value::as_array)
                .map_or_else(Vec::new, |links| {
                    links
                        .iter()
                        .filter_map(|link| {
                            let link = link.as_object()?;
                            Some(AuthLink {
                                url: link.get("url")?.as_str()?.to_owned(),
                                label: optional_string(link.get("label")),
                            })
                        })
                        .collect()
                }),
        }),
        "url" => Ok(AuthNotice::Url {
            url: string_field(object, "url")?.to_owned(),
            instructions: optional_string(object.get("instructions")),
        }),
        "device_code" => Ok(AuthNotice::DeviceCode {
            user_code: string_field(object, "userCode")?.to_owned(),
            verification_uri: string_field(object, "verificationUri")?.to_owned(),
            expires_in_seconds: object.get("expiresInSeconds").and_then(Value::as_u64),
        }),
        "progress" => Ok(AuthNotice::Progress {
            message: string_field(object, "message")?.to_owned(),
        }),
        kind => Err(BackendError::Protocol(format!(
            "unknown authentication notice kind {kind}"
        ))),
    }
}

fn decode_auth_finished(object: &Map<String, Value>) -> Result<BackendEvent, BackendError> {
    let result = object
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(|| BackendError::Protocol("missing authentication result".to_owned()))?;
    let outcome = match result.get("kind").and_then(Value::as_str) {
        Some("succeeded") => Ok(()),
        Some("cancelled") => Err("Authentication was cancelled".to_owned()),
        Some("failed") => Err(result
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Authentication failed")
            .to_owned()),
        _ => Err("Unknown authentication result".to_owned()),
    };
    Ok(BackendEvent::AuthFinished {
        flow_id: parse_auth_flow_id_field(object, "flowId")?,
        provider_id: string_field(object, "providerId")?.to_owned(),
        result: outcome,
    })
}

fn decode_extension_request(value: &Value) -> Result<ExtensionUiRequest, BackendError> {
    let object = object(value, "extension UI request")?;
    let title = string_field(object, "title")?.to_owned();
    match string_field(object, "kind")? {
        "select" => Ok(ExtensionUiRequest::Select {
            title,
            options: string_array(object.get("options")),
        }),
        "confirm" => Ok(ExtensionUiRequest::Confirm {
            title,
            message: string_field(object, "message")?.to_owned(),
        }),
        "input" => Ok(ExtensionUiRequest::Input {
            title,
            placeholder: optional_string(object.get("placeholder")),
            secret: object
                .get("secret")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "editor" => Ok(ExtensionUiRequest::Editor {
            title,
            prefill: optional_string(object.get("prefill")),
        }),
        kind => Err(BackendError::Protocol(format!(
            "unknown extension UI request kind {kind}"
        ))),
    }
}

fn finish_child(
    status: ExitStatus,
    outputs: &BackendOutputSender,
    pending: &mut HashMap<RequestId, PendingReply>,
) -> Result<(), BackendError> {
    if status.success() {
        fail_pending(outputs, pending, BackendError::Disconnected)?;
        return Ok(());
    }
    let error = BackendError::Transport(format!("headless runtime exited with {status}"));
    fail_pending(outputs, pending, error.clone())?;
    Err(error)
}

fn fail_process(
    child: &mut Child,
    outputs: &BackendOutputSender,
    pending: &mut HashMap<RequestId, PendingReply>,
    error: BackendError,
) -> Result<(), BackendError> {
    let _ = child.kill();
    fail_pending(outputs, pending, error.clone())?;
    Err(error)
}

fn fail_pending(
    outputs: &BackendOutputSender,
    pending: &mut HashMap<RequestId, PendingReply>,
    error: BackendError,
) -> Result<(), BackendError> {
    for request_id in pending.drain().map(|(request_id, _)| request_id) {
        outputs.reply(request_id, Err(error.clone()))?;
    }
    Ok(())
}

fn object<'a>(value: &'a Value, context: &str) -> Result<&'a Map<String, Value>, BackendError> {
    value
        .as_object()
        .ok_or_else(|| BackendError::Protocol(format!("{context} must be an object")))
}

fn array<'a>(value: &'a Value, context: &str) -> Result<&'a [Value], BackendError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| BackendError::Protocol(format!("{context} must be an array")))
}

fn string_field<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str, BackendError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| BackendError::Protocol(format!("missing string field {field}")))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(ToOwned::to_owned)
}

fn optional_id<T, E>(
    value: Option<&Value>,
    parse: impl Fn(&str) -> Result<T, E>,
) -> Result<Option<T>, BackendError>
where
    E: std::fmt::Display,
{
    value
        .and_then(Value::as_str)
        .map(parse)
        .transpose()
        .map_err(|error| BackendError::Protocol(error.to_string()))
}

fn session_id_from_value(value: &Value) -> Option<Result<SessionId, BackendError>> {
    let id = value
        .as_str()
        .or_else(|| value.get("id").and_then(Value::as_str))?;
    Some(SessionId::parse(id).map_err(|error| BackendError::Protocol(error.to_string())))
}

fn bool_path(value: &Value, path: &[&str]) -> bool {
    path.iter()
        .try_fold(value, |current, segment| current.get(*segment))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect()
        })
}

fn parse_run_id_field(
    object: &Map<String, Value>,
    field: &str,
) -> Result<RunId, BackendError> {
    RunId::parse(string_field(object, field)?)
        .map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_tool_call_id_field(
    object: &Map<String, Value>,
    field: &str,
) -> Result<ToolCallId, BackendError> {
    ToolCallId::parse(string_field(object, field)?)
        .map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_auth_flow_id_field(
    object: &Map<String, Value>,
    field: &str,
) -> Result<AuthFlowId, BackendError> {
    AuthFlowId::parse(string_field(object, field)?)
        .map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_run_kind(value: Option<&str>) -> RunKind {
    match value {
        Some("agent") => RunKind::Agent,
        Some("workflow") => RunKind::Workflow,
        _ => RunKind::Root,
    }
}

fn parse_run_state(value: Option<&str>) -> RunState {
    match value {
        Some("created") => RunState::Created,
        Some("starting") => RunState::Starting,
        Some("running") => RunState::Running,
        Some("waiting") => RunState::Waiting,
        Some("completing") => RunState::Completing,
        Some("completed") => RunState::Completed,
        Some("failed") => RunState::Failed,
        Some("cancelled") => RunState::Cancelled,
        Some("orphaned") => RunState::Orphaned,
        _ => RunState::Created,
    }
}

fn parse_thinking_level(value: &str) -> Option<ThinkingLevel> {
    match value {
        "off" => Some(ThinkingLevel::Off),
        "minimal" => Some(ThinkingLevel::Minimal),
        "low" => Some(ThinkingLevel::Low),
        "medium" => Some(ThinkingLevel::Medium),
        "high" => Some(ThinkingLevel::High),
        "xhigh" => Some(ThinkingLevel::ExtraHigh),
        "max" => Some(ThinkingLevel::Max),
        _ => None,
    }
}

fn event_message(object: &Map<String, Value>) -> String {
    object
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| {
            object
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .or_else(|| object.get("state").and_then(Value::as_str))
        .unwrap_or("Runtime event")
        .to_owned()
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        encoded.push(TABLE[(first >> 2) as usize] as char);
        encoded.push(TABLE[(((first & 0b11) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(TABLE[(((second & 0b1111) << 2) | (third >> 6)) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(TABLE[(third & 0b11_1111) as usize] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{ClientInformation, SecretValue};

    #[test]
    fn commands_use_the_closed_camel_case_wire_contract() {
        let request = BackendRequest {
            id: RequestId::parse("request-1").expect("request ID"),
            command: BackendCommand::Initialize {
                client: ClientInformation {
                    name: "phenix".to_owned(),
                    build: "test".to_owned(),
                },
            },
        };
        assert_eq!(
            request_frame(&request).expect("frame"),
            json!({
                "kind": "request",
                "id": "request-1",
                "command": {
                    "type": "initialize",
                    "client": { "name": "phenix", "build": "test" },
                },
            })
        );
    }

    #[test]
    fn secret_values_are_serialized_only_at_the final_transport_boundary() {
        let command = BackendCommand::AuthLoginRespond {
            flow_id: AuthFlowId::parse("flow-1").expect("flow ID"),
            response: AuthPromptResponse::Secret(SecretValue::from_utf8("secret")),
        };
        let frame = command_value(&command).expect("wire command");
        assert_eq!(frame["response"]["value"], "secret");
        assert!(!format!("{command:?}").contains("secret"));
    }

    #[test]
    fn base64_encoding_is_dependency_free_and_padded() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
    }

    #[test]
    fn current_headless_snapshot_projects_into_runtime_domain() {
        let snapshot = decode_snapshot(&json!({
            "health": "ready",
            "capabilities": {
                "prompting": { "steering": true, "followUps": true },
                "extensionUi": { "selection": true }
            },
            "activeSession": {
                "id": "session-1",
                "name": "Root",
                "file": "/tmp/session.jsonl",
                "cwd": "/tmp"
            },
            "rootRunId": "run-root",
            "selectedRunId": "run-root",
            "workspace": {
                "tree": {
                    "root": {
                        "run": {
                            "id": "run-root",
                            "kind": "root",
                            "definitionId": "root.session",
                            "state": "running"
                        },
                        "children": []
                    }
                }
            }
        }))
        .expect("snapshot");
        assert_eq!(snapshot.health, BackendHealth::Ready);
        assert_eq!(snapshot.sessions.len(), 1);
        assert_eq!(snapshot.runs.len(), 1);
        assert!(snapshot.capabilities.prompting.steering);
    }
}
