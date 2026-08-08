use phenix_runtime_api::{
    AuthFlowId, AuthLink, AuthMethod, AuthNotice, AuthPrompt, AuthPromptOption, AuthPromptResponse,
    AuthProviderSummary, AuthenticationCapabilities, BackendCapabilities, BackendCommand,
    BackendError, BackendEvent, BackendHealth, BackendReply, BackendRequest, CommandSource,
    CommandSummary, DialogId, ExtensionUiCapabilities, ExtensionUiRequest, ExtensionUiResponse,
    ImageInput, ModelCapabilities, ModelRef, ModelSummary, NotificationLevel, ObjectiveId,
    ObjectiveSource, ObjectiveState, ObjectiveSummary, PersistedSessionSummary,
    PersistedSessionTreeSnapshot, PromptCapabilities, ResourceCapabilities, RunId, RunKind,
    RunOutcome, RunState, RunSummary, SessionCapabilities, SessionEntryId, SessionEntryKind,
    SessionEntrySummary, SessionId, StreamingBehavior, ThinkingLevel, ToolCallId,
    ToolExecutionOutcome, TranscriptBlock, TranscriptRole,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
pub(crate) enum WireOutboundFrame {
    #[serde(rename = "response")]
    Response { id: String, result: WireResult },
    #[serde(rename = "event")]
    Event { event: Value },
}

#[derive(Debug, Deserialize)]
pub(crate) struct WireResult {
    pub(crate) ok: bool,
    #[serde(default)]
    pub(crate) reply: Option<Value>,
    #[serde(default)]
    pub(crate) error: Option<WireError>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WireError {
    pub(crate) code: String,
    pub(crate) message: String,
    #[allow(dead_code)]
    pub(crate) retryable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PendingReply {
    Initialize,
    Snapshot,
    Sessions,
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
    pub(crate) fn for_command(command: &BackendCommand) -> Self {
        match command {
            BackendCommand::Initialize { .. } => Self::Initialize,
            BackendCommand::SnapshotRequest => Self::Snapshot,
            BackendCommand::SessionList => Self::Sessions,
            BackendCommand::SessionTree { .. } => Self::SessionTree,
            BackendCommand::ModelList => Self::Models,
            BackendCommand::ThinkingLevels { .. } => Self::ThinkingLevels,
            BackendCommand::SessionModes { .. } => Self::Accepted,
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
            | BackendCommand::SessionModeSelect { .. }
            | BackendCommand::ModelSelect { .. }
            | BackendCommand::ThinkingSelect { .. }
            | BackendCommand::AuthLoginStart { .. }
            | BackendCommand::AuthLoginRespond { .. }
            | BackendCommand::AuthLoginCancel { .. }
            | BackendCommand::AuthTerminalFinished { .. }
            | BackendCommand::CompactionStart { .. }
            | BackendCommand::RetryConfigure { .. }
            | BackendCommand::CommandInvoke { .. }
            | BackendCommand::ExtensionUiRespond { .. } => Self::Accepted,
        }
    }
}

pub(crate) fn encode_request(request: &BackendRequest) -> Result<Value, BackendError> {
    Ok(json!({
        "kind": "request",
        "id": request.id.as_str(),
        "command": encode_command(&request.command)?,
    }))
}

fn encode_command(command: &BackendCommand) -> Result<Value, BackendError> {
    Ok(match command {
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
            "images": encode_images(images),
            "streamingBehavior": streaming_behavior.as_ref().map(encode_streaming_behavior),
        }),
        BackendCommand::PromptSteer {
            run_id,
            text,
            images,
        } => json!({
            "type": "prompt.steer",
            "runId": run_id.as_str(),
            "text": text,
            "images": encode_images(images),
        }),
        BackendCommand::PromptFollowUp {
            run_id,
            text,
            images,
        } => json!({
            "type": "prompt.follow_up",
            "runId": run_id.as_str(),
            "text": text,
            "images": encode_images(images),
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
        BackendCommand::SessionModes { .. }
        | BackendCommand::SessionModeSelect { .. }
        | BackendCommand::AuthTerminalFinished { .. } => {
            return Err(BackendError::Unsupported(
                "the explicit process fallback does not support ACP-only commands".to_owned(),
            ));
        }
        BackendCommand::SessionExport { session_id, path } => json!({
            "type": "session.export",
            "sessionId": session_id.as_str(),
            "path": path,
        }),
        BackendCommand::ModelList => json!({ "type": "model.list" }),
        BackendCommand::ModelSelect { run_id, model } => json!({
            "type": "model.select",
            "runId": run_id.as_str(),
            "model": encode_model(model),
        }),
        BackendCommand::ThinkingLevels { run_id } => json!({
            "type": "thinking.levels",
            "runId": run_id.as_str(),
        }),
        BackendCommand::ThinkingSelect { run_id, level } => json!({
            "type": "thinking.select",
            "runId": run_id.as_str(),
            "level": encode_thinking_level(level),
        }),
        BackendCommand::AuthProviders => json!({ "type": "auth.providers" }),
        BackendCommand::AuthLoginStart {
            provider_id,
            method,
        } => json!({
            "type": "auth.login.start",
            "providerId": provider_id,
            "method": encode_auth_method(method),
        }),
        BackendCommand::AuthLoginRespond { flow_id, response } => json!({
            "type": "auth.login.respond",
            "flowId": flow_id.as_str(),
            "response": encode_auth_response(response)?,
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
            "response": encode_extension_response(response),
        }),
        BackendCommand::Shutdown => json!({ "type": "shutdown" }),
    })
}

fn encode_images(images: &[ImageInput]) -> Vec<Value> {
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

fn encode_model(model: &ModelRef) -> Value {
    json!({ "provider": model.provider, "model": model.model })
}

fn encode_streaming_behavior(behavior: &StreamingBehavior) -> &'static str {
    match behavior {
        StreamingBehavior::Steer => "steer",
        StreamingBehavior::FollowUp => "follow_up",
    }
}

fn encode_thinking_level(level: &ThinkingLevel) -> &'static str {
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

fn encode_auth_method(method: &AuthMethod) -> &'static str {
    match method {
        AuthMethod::OAuth => "oauth",
        AuthMethod::ApiKey => "api_key",
        AuthMethod::Terminal => "terminal",
    }
}

fn encode_auth_response(response: &AuthPromptResponse) -> Result<Value, BackendError> {
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

fn encode_extension_response(response: &ExtensionUiResponse) -> Value {
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

pub(crate) fn decode_reply(kind: PendingReply, value: Value) -> Result<BackendReply, BackendError> {
    match kind {
        PendingReply::Initialize => {
            let object = object(&value, "initialize reply")?;
            let capabilities =
                decode_capabilities(object.get("capabilities").unwrap_or(&Value::Null));
            let mut snapshot = decode_snapshot(object.get("snapshot").unwrap_or(&Value::Null))?;
            snapshot.capabilities = capabilities.clone();
            Ok(BackendReply::Initialized {
                capabilities,
                snapshot,
            })
        }
        PendingReply::Snapshot => Ok(BackendReply::Snapshot(decode_snapshot(&value)?)),
        PendingReply::Sessions => Ok(BackendReply::Sessions(decode_sessions(&value)?)),
        PendingReply::SessionTree => Ok(BackendReply::SessionTree(decode_session_tree(&value)?)),
        PendingReply::Models => Ok(BackendReply::Models(decode_models(&value)?)),
        PendingReply::ThinkingLevels => Ok(BackendReply::ThinkingLevels(decode_thinking_levels(
            &value,
        )?)),
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
    let active_session = object
        .get("activeSession")
        .and_then(session_id_from_value)
        .transpose()?;
    let root_run = optional_run_id(object.get("rootRunId"))?;
    let selected_run = optional_run_id(object.get("selectedRunId"))?;
    let mut sessions = object
        .get("sessions")
        .map_or_else(|| Ok(Vec::new()), decode_sessions)?;
    if sessions.is_empty() {
        if let Some(active) = object
            .get("activeSession")
            .filter(|value| value.is_object())
        {
            sessions.push(decode_session(active)?);
        }
    }

    let workspace = object.get("workspace");
    let runs = object
        .get("runs")
        .or_else(|| workspace.and_then(|value| value.get("runs")))
        .or_else(|| workspace.and_then(|value| value.get("tree")))
        .map_or_else(|| Ok(Vec::new()), decode_runs)?;
    let objectives = object
        .get("objectives")
        .or_else(|| workspace.and_then(|value| value.get("objectives")))
        .map_or_else(|| Ok(Vec::new()), decode_objectives)?;

    Ok(phenix_runtime_api::RuntimeSnapshot {
        capabilities,
        health: decode_health(object),
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
            terminal: false,
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

fn decode_health(object: &Map<String, Value>) -> BackendHealth {
    let message = optional_string(object.get("message")).unwrap_or_default();
    match object.get("health").and_then(Value::as_str) {
        Some("ready") => BackendHealth::Ready,
        Some("degraded") => BackendHealth::Degraded {
            message: non_empty_or(message, "Runtime is degraded"),
        },
        Some("failed") => BackendHealth::Failed {
            message: non_empty_or(message, "Runtime failed"),
        },
        Some("stopped") => BackendHealth::Stopped,
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
        id: parse_session_id(string_field(object, "id")?)?,
        name: optional_string(object.get("name")),
        session_file: optional_string(object.get("path").or_else(|| object.get("file"))),
        cwd: optional_string(object.get("cwd")),
        root_run_id: optional_run_id(object.get("rootRunId"))?,
        updated_at: optional_string(object.get("updatedAt")),
    })
}

fn decode_runs(value: &Value) -> Result<Vec<RunSummary>, BackendError> {
    if let Some(values) = value.as_array() {
        return values.iter().map(decode_run).collect();
    }
    let root = value.get("root").unwrap_or(value);
    let mut runs = Vec::new();
    decode_run_node(root, &mut runs)?;
    Ok(runs)
}

fn decode_run_node(value: &Value, runs: &mut Vec<RunSummary>) -> Result<(), BackendError> {
    let run = value.get("run").unwrap_or(value);
    if run.get("id").is_some() {
        runs.push(decode_run(run)?);
    }
    if let Some(children) = value.get("children").and_then(Value::as_array) {
        for child in children {
            decode_run_node(child, runs)?;
        }
    }
    Ok(())
}

fn decode_run(value: &Value) -> Result<RunSummary, BackendError> {
    let object = object(value, "run")?;
    let definition_id = object
        .get("definitionId")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let profile = object.get("profile").and_then(Value::as_object);
    let resolved_model = object.get("resolvedModel").and_then(Value::as_object);
    Ok(RunSummary {
        id: parse_run_id(string_field(object, "id")?)?,
        parent: optional_run_id(object.get("parentId"))?,
        kind: parse_run_kind(object.get("kind").and_then(Value::as_str)),
        display_name: object
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(&definition_id)
            .to_owned(),
        definition_id,
        state: parse_run_state(object.get("state").and_then(Value::as_str)),
        persisted_session: object
            .get("pi")
            .and_then(|pi| pi.get("sessionId"))
            .and_then(Value::as_str)
            .map(parse_session_id)
            .transpose()?,
        session_file: object
            .get("pi")
            .and_then(|pi| pi.get("sessionFile"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        model: resolved_model.and_then(decode_model_ref),
        thinking_level: profile
            .and_then(|value| value.get("thinkingLevel"))
            .and_then(Value::as_str)
            .and_then(parse_thinking_level),
        difficulty: profile
            .and_then(|value| value.get("difficulty"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        budget: profile
            .and_then(|value| value.get("budget"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        pending_messages: object
            .get("pendingMessages")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0),
        outcome: decode_outcome(object.get("outcome")),
    })
}

fn decode_model_ref(object: &Map<String, Value>) -> Option<ModelRef> {
    Some(ModelRef {
        provider: object.get("provider")?.as_str()?.to_owned(),
        model: object
            .get("model")
            .or_else(|| object.get("modelId"))?
            .as_str()?
            .to_owned(),
    })
}

fn decode_outcome(value: Option<&Value>) -> Option<RunOutcome> {
    let object = value?.as_object()?;
    match object.get("kind").and_then(Value::as_str)? {
        "success" => Some(RunOutcome::Success),
        "failure" => Some(RunOutcome::Failure {
            code: nested_string(object, &["error", "code"])
                .unwrap_or("failure")
                .to_owned(),
            message: nested_string(object, &["error", "message"])
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
    let values = if let Some(values) = value.as_array() {
        values
    } else if let Some(values) = value.get("items").and_then(Value::as_array) {
        values
    } else {
        return Ok(Vec::new());
    };
    values.iter().filter_map(decode_objective).collect()
}

fn decode_objective(value: &Value) -> Option<Result<ObjectiveSummary, BackendError>> {
    let object = value.as_object()?;
    Some((|| {
        let root_run_id = parse_run_id(string_field(object, "rootRunId")?)?;
        let created_by_run_id = object
            .get("createdByRunId")
            .and_then(Value::as_str)
            .map(parse_run_id)
            .transpose()?
            .unwrap_or_else(|| root_run_id.clone());
        Ok(ObjectiveSummary {
            id: parse_objective_id(string_field(object, "id")?)?,
            root_run_id,
            parent: object
                .get("parentId")
                .and_then(Value::as_str)
                .map(parse_objective_id)
                .transpose()?,
            created_by_run_id,
            title: string_field(object, "title")?.to_owned(),
            description: optional_string(object.get("description")),
            source: match object.get("source").and_then(Value::as_str) {
                Some("discovered") => ObjectiveSource::Discovered,
                _ => ObjectiveSource::User,
            },
            state: match object.get("state").and_then(Value::as_str) {
                Some("work_in_progress") | Some("in_progress") => ObjectiveState::WorkInProgress,
                Some("done") | Some("completed") => ObjectiveState::Done,
                Some("blocked") => ObjectiveState::Blocked,
                _ => ObjectiveState::NotStarted,
            },
        })
    })())
}

fn decode_session_tree(value: &Value) -> Result<PersistedSessionTreeSnapshot, BackendError> {
    let object = object(value, "session tree")?;
    let entries = object
        .get("tree")
        .or_else(|| object.get("entries"))
        .and_then(Value::as_array)
        .map_or_else(Vec::new, |values| {
            values.iter().filter_map(decode_session_entry).collect()
        });
    Ok(PersistedSessionTreeSnapshot {
        session_id: parse_session_id(string_field(object, "sessionId")?)?,
        leaf_entry: optional_session_entry_id(object.get("leafEntryId"))?,
        entries,
    })
}

fn decode_session_entry(value: &Value) -> Option<SessionEntrySummary> {
    let object = value.as_object()?;
    let kind = match object.get("type").and_then(Value::as_str) {
        Some("message") => match nested_string(object, &["message", "role"]) {
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
        id: parse_session_entry_id(object.get("id")?.as_str()?).ok()?,
        parent: object
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|value| parse_session_entry_id(value).ok()),
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
                    .unwrap_or("model")
                    .to_owned(),
                supports_images: input.is_some_and(|values| {
                    values.iter().any(|value| value.as_str() == Some("image"))
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
        .map(|value| {
            value
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
            let methods =
                object
                    .get("methods")
                    .and_then(Value::as_array)
                    .map_or_else(Vec::new, |values| {
                        values
                            .iter()
                            .filter_map(|value| match value.as_str() {
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
                    .unwrap_or("provider")
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

pub(crate) fn decode_event(value: Value) -> Result<Option<BackendEvent>, BackendError> {
    let object = object(&value, "runtime event")?;
    let event_type = string_field(object, "type")?;
    Ok(match event_type {
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
            run_id: parse_run_id(string_field(object, "runId")?)?,
            tool_call_id: parse_tool_call_id(string_field(object, "toolCallId")?)?,
            tool_name: string_field(object, "toolName")?.to_owned(),
            raw_input_json: object
                .get("rawInput")
                .or_else(|| object.get("input"))
                .map_or_else(
                    || {
                        json!({
                            "summary": object
                                .get("inputSummary")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                        })
                        .to_string()
                    },
                    |value| value.to_string(),
                ),
            input_summary: string_field(object, "inputSummary")?.to_owned(),
        }),
        "tool.updated" => Some(BackendEvent::ToolUpdated {
            run_id: parse_run_id(string_field(object, "runId")?)?,
            tool_call_id: parse_tool_call_id(string_field(object, "toolCallId")?)?,
            output: string_field(object, "output")?.to_owned(),
        }),
        "tool.finished" => Some(BackendEvent::ToolFinished {
            run_id: parse_run_id(string_field(object, "runId")?)?,
            tool_call_id: parse_tool_call_id(string_field(object, "toolCallId")?)?,
            outcome: match object.get("outcome").and_then(Value::as_str) {
                Some("succeeded") => ToolExecutionOutcome::Succeeded,
                Some("failed") => ToolExecutionOutcome::Failed,
                _ => ToolExecutionOutcome::Aborted,
            },
            output_summary: string_field(object, "outputSummary")?.to_owned(),
        }),
        "queue.changed" => Some(BackendEvent::QueueChanged {
            run_id: parse_run_id(string_field(object, "runId")?)?,
            steering: string_array(object.get("steering")),
            follow_ups: string_array(object.get("followUps")),
        }),
        "auth.prompt.requested" => Some(BackendEvent::AuthPromptRequested {
            flow_id: parse_auth_flow_id(string_field(object, "flowId")?)?,
            prompt: decode_auth_prompt(object.get("prompt").unwrap_or(&Value::Null))?,
        }),
        "auth.notice" => Some(BackendEvent::AuthNotice {
            flow_id: parse_auth_flow_id(string_field(object, "flowId")?)?,
            notice: decode_auth_notice(object.get("notice").unwrap_or(&Value::Null))?,
        }),
        "auth.finished" => Some(decode_auth_finished(object)?),
        "extension_ui.requested" => Some(BackendEvent::ExtensionUiRequested {
            dialog_id: parse_dialog_id(string_field(object, "dialogId")?)?,
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
        "runtime.health" => Some(BackendEvent::HealthChanged(decode_health(object))),
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
        "protocol.error" | "extension.error" | "runtime.diagnostic" => {
            Some(BackendEvent::Notification {
                level: NotificationLevel::Warning,
                message: event_message(object),
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
        | "tools.expanded" => None,
        unknown => Some(BackendEvent::Notification {
            level: NotificationLevel::Warning,
            message: format!("Unhandled runtime event: {unknown}"),
        }),
    })
}

fn decode_transcript_block(value: &Value) -> Result<TranscriptBlock, BackendError> {
    let object = object(value, "transcript block")?;
    Ok(TranscriptBlock {
        id: string_field(object, "id")?.to_owned(),
        run_id: parse_run_id(string_field(object, "runId")?)?,
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
            options: object.get("options").and_then(Value::as_array).map_or_else(
                Vec::new,
                |values| {
                    values
                        .iter()
                        .filter_map(|value| {
                            let option = value.as_object()?;
                            Some(AuthPromptOption {
                                id: option.get("id")?.as_str()?.to_owned(),
                                label: option.get("label")?.as_str()?.to_owned(),
                                description: optional_string(option.get("description")),
                            })
                        })
                        .collect()
                },
            ),
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
                .map_or_else(Vec::new, |values| {
                    values
                        .iter()
                        .filter_map(|value| {
                            let link = value.as_object()?;
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
        flow_id: parse_auth_flow_id(string_field(object, "flowId")?)?,
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

fn nested_string<'a>(object: &'a Map<String, Value>, path: &[&str]) -> Option<&'a str> {
    let mut value = object.get(*path.first()?)?;
    for segment in &path[1..] {
        value = value.get(*segment)?;
    }
    value.as_str()
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(ToOwned::to_owned)
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

fn bool_path(value: &Value, path: &[&str]) -> bool {
    path.iter()
        .try_fold(value, |current, segment| current.get(*segment))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn session_id_from_value(value: &Value) -> Option<Result<SessionId, BackendError>> {
    let id = value
        .as_str()
        .or_else(|| value.get("id").and_then(Value::as_str))?;
    Some(parse_session_id(id))
}

fn optional_run_id(value: Option<&Value>) -> Result<Option<RunId>, BackendError> {
    value.and_then(Value::as_str).map(parse_run_id).transpose()
}

fn optional_session_entry_id(
    value: Option<&Value>,
) -> Result<Option<SessionEntryId>, BackendError> {
    value
        .and_then(Value::as_str)
        .map(parse_session_entry_id)
        .transpose()
}

fn parse_run_id(value: &str) -> Result<RunId, BackendError> {
    RunId::parse(value).map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_session_id(value: &str) -> Result<SessionId, BackendError> {
    SessionId::parse(value).map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_session_entry_id(value: &str) -> Result<SessionEntryId, BackendError> {
    SessionEntryId::parse(value).map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_objective_id(value: &str) -> Result<ObjectiveId, BackendError> {
    ObjectiveId::parse(value).map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_auth_flow_id(value: &str) -> Result<AuthFlowId, BackendError> {
    AuthFlowId::parse(value).map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_dialog_id(value: &str) -> Result<DialogId, BackendError> {
    DialogId::parse(value).map_err(|error| BackendError::Protocol(error.to_string()))
}

fn parse_tool_call_id(value: &str) -> Result<ToolCallId, BackendError> {
    ToolCallId::parse(value).map_err(|error| BackendError::Protocol(error.to_string()))
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

fn non_empty_or(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_owned()
    } else {
        value
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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
    use phenix_runtime_api::{ClientInformation, RequestId, SecretValue};

    #[test]
    fn commands_use_the_closed_camel_case_contract() {
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
            encode_request(&request).expect("frame"),
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
    fn secret_values_are_serialized_only_at_the_transport_boundary() {
        let command = BackendCommand::AuthLoginRespond {
            flow_id: AuthFlowId::parse("flow-1").expect("flow ID"),
            response: AuthPromptResponse::Secret(SecretValue::from_utf8("secret")),
        };
        let frame = encode_command(&command).expect("wire command");
        assert_eq!(frame["response"]["value"], "secret");
        assert!(!format!("{command:?}").contains("secret"));
    }

    #[test]
    fn base64_encoding_is_padded() {
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

    #[test]
    fn objective_without_creator_reuses_the_validated_root_run() {
        let objectives = decode_objectives(&json!([{
            "id": "objective-1",
            "rootRunId": "run-root",
            "title": "Root objective",
            "state": "not_started"
        }]))
        .expect("objectives");
        assert_eq!(objectives.len(), 1);
        assert_eq!(objectives[0].created_by_run_id, objectives[0].root_run_id);
    }
}
