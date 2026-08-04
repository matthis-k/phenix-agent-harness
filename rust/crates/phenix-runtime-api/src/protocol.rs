use crate::id::{AuthFlowId, DialogId, RunId, SessionId, ToolCallId};
use std::fmt::{self, Debug, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClientInformation {
    pub name: String,
    pub build: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BackendCapabilities {
    pub prompting: PromptCapabilities,
    pub sessions: SessionCapabilities,
    pub authentication: AuthenticationCapabilities,
    pub models: ModelCapabilities,
    pub resources: ResourceCapabilities,
    pub extension_ui: ExtensionUiCapabilities,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PromptCapabilities {
    pub steering: bool,
    pub follow_ups: bool,
    pub images: bool,
    pub compaction: bool,
    pub retry_control: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SessionCapabilities {
    pub persistence: bool,
    pub switching: bool,
    pub branching: bool,
    pub import: bool,
    pub export: bool,
    pub tree: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AuthenticationCapabilities {
    pub provider_listing: bool,
    pub oauth: bool,
    pub api_keys: bool,
    pub device_code: bool,
    pub browser_callback: bool,
    pub logout: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelCapabilities {
    pub listing: bool,
    pub selection: bool,
    pub thinking_levels: bool,
    pub virtual_models: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ResourceCapabilities {
    pub commands: bool,
    pub extensions: bool,
    pub skills: bool,
    pub prompt_templates: bool,
    pub reload: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ExtensionUiCapabilities {
    pub selection: bool,
    pub confirmation: bool,
    pub text_input: bool,
    pub secret_input: bool,
    pub editor: bool,
    pub notifications: bool,
    pub status: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StreamingBehavior {
    Steer,
    FollowUp,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImageInput {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelRef {
    pub provider: String,
    pub model: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelSummary {
    pub model: ModelRef,
    pub display_name: String,
    pub supports_images: bool,
    pub supports_thinking: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    ExtraHigh,
    Max,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthMethod {
    OAuth,
    ApiKey,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthProviderSummary {
    pub id: String,
    pub display_name: String,
    pub methods: Vec<AuthMethod>,
    pub configured: bool,
    pub source: Option<String>,
}

#[derive(Clone, Eq, PartialEq)]
pub struct SecretValue(Vec<u8>);

impl SecretValue {
    pub fn from_utf8(value: impl Into<String>) -> Self {
        Self(value.into().into_bytes())
    }

    pub fn expose(&self) -> Result<&str, std::str::Utf8Error> {
        std::str::from_utf8(&self.0)
    }
}

impl Debug for SecretValue {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretValue([redacted])")
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.fill(0);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthPromptResponse {
    Text(String),
    Secret(SecretValue),
    Selected(String),
    ManualCode(String),
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExtensionUiResponse {
    Selected(String),
    Confirmed(bool),
    Text(String),
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendCommand {
    Initialize {
        client: ClientInformation,
    },
    SnapshotRequest,
    PromptSubmit {
        session_id: SessionId,
        text: String,
        images: Vec<ImageInput>,
        streaming_behavior: Option<StreamingBehavior>,
    },
    PromptSteer {
        session_id: SessionId,
        text: String,
        images: Vec<ImageInput>,
    },
    PromptFollowUp {
        session_id: SessionId,
        text: String,
        images: Vec<ImageInput>,
    },
    ExecutionAbort {
        run_id: Option<RunId>,
    },
    SessionCreate {
        parent: Option<SessionId>,
    },
    SessionSwitch {
        session_id: SessionId,
    },
    SessionFork {
        session_id: SessionId,
        entry_id: String,
    },
    SessionClone {
        session_id: SessionId,
    },
    SessionRename {
        session_id: SessionId,
        name: String,
    },
    SessionList,
    SessionTree {
        session_id: SessionId,
    },
    SessionExport {
        session_id: SessionId,
        path: Option<String>,
    },
    ModelList,
    ModelSelect {
        session_id: SessionId,
        model: ModelRef,
    },
    ThinkingLevels {
        session_id: SessionId,
    },
    ThinkingSelect {
        session_id: SessionId,
        level: ThinkingLevel,
    },
    AuthProviders,
    AuthLoginStart {
        provider_id: String,
        method: AuthMethod,
    },
    AuthLoginRespond {
        flow_id: AuthFlowId,
        response: AuthPromptResponse,
    },
    AuthLoginCancel {
        flow_id: AuthFlowId,
    },
    AuthLogout {
        provider_id: String,
    },
    CompactionStart {
        session_id: SessionId,
        instructions: Option<String>,
    },
    CompactionAbort {
        session_id: SessionId,
    },
    RetryConfigure {
        session_id: SessionId,
        enabled: bool,
    },
    RetryAbort {
        session_id: SessionId,
    },
    CommandList,
    CommandInvoke {
        session_id: SessionId,
        name: String,
        arguments: String,
    },
    ResourceReload,
    ExtensionUiRespond {
        dialog_id: DialogId,
        response: ExtensionUiResponse,
    },
    Shutdown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendReply {
    Accepted,
    Initialized {
        capabilities: BackendCapabilities,
        snapshot: RuntimeSnapshot,
    },
    Snapshot(RuntimeSnapshot),
    Sessions(Vec<SessionSummary>),
    SessionTree(SessionTreeSnapshot),
    Models(Vec<ModelSummary>),
    ThinkingLevels(Vec<ThinkingLevel>),
    AuthProviders(Vec<AuthProviderSummary>),
    Commands(Vec<CommandSummary>),
    Exported {
        path: String,
    },
    Completed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeSnapshot {
    pub capabilities: BackendCapabilities,
    pub health: BackendHealth,
    pub active_session: Option<SessionId>,
    pub sessions: Vec<SessionSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendHealth {
    Starting,
    Ready,
    Degraded { message: String },
    Failed { message: String },
    Stopped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionSummary {
    pub id: SessionId,
    pub parent: Option<SessionId>,
    pub name: Option<String>,
    pub model: Option<ModelRef>,
    pub thinking_level: ThinkingLevel,
    pub is_streaming: bool,
    pub pending_messages: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionTreeSnapshot {
    pub root: SessionId,
    pub nodes: Vec<SessionSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSummary {
    pub name: String,
    pub description: Option<String>,
    pub source: CommandSource,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandSource {
    BuiltIn,
    Extension,
    Skill,
    PromptTemplate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TranscriptRole {
    User,
    Assistant,
    Thinking,
    Tool,
    System,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptBlock {
    pub id: String,
    pub session_id: SessionId,
    pub role: TranscriptRole,
    pub text: String,
    pub complete: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolExecutionOutcome {
    Succeeded,
    Failed,
    Aborted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthPrompt {
    Text {
        message: String,
        placeholder: Option<String>,
    },
    Secret {
        message: String,
        placeholder: Option<String>,
    },
    Select {
        message: String,
        options: Vec<AuthPromptOption>,
    },
    ManualCode {
        message: String,
        placeholder: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthPromptOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthNotice {
    Information {
        message: String,
        links: Vec<AuthLink>,
    },
    Url {
        url: String,
        instructions: Option<String>,
    },
    DeviceCode {
        user_code: String,
        verification_uri: String,
        expires_in_seconds: Option<u64>,
    },
    Progress {
        message: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthLink {
    pub url: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExtensionUiRequest {
    Select {
        title: String,
        options: Vec<String>,
    },
    Confirm {
        title: String,
        message: String,
    },
    Input {
        title: String,
        placeholder: Option<String>,
        secret: bool,
    },
    Editor {
        title: String,
        prefill: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NotificationLevel {
    Information,
    Warning,
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendEvent {
    SnapshotChanged(RuntimeSnapshot),
    SessionChanged(SessionSummary),
    TranscriptAppended(TranscriptBlock),
    TranscriptUpdated(TranscriptBlock),
    ToolStarted {
        session_id: SessionId,
        tool_call_id: ToolCallId,
        tool_name: String,
        input_summary: String,
    },
    ToolUpdated {
        tool_call_id: ToolCallId,
        output: String,
    },
    ToolFinished {
        tool_call_id: ToolCallId,
        outcome: ToolExecutionOutcome,
        output_summary: String,
    },
    QueueChanged {
        session_id: SessionId,
        steering: Vec<String>,
        follow_ups: Vec<String>,
    },
    AuthPromptRequested {
        flow_id: AuthFlowId,
        prompt: AuthPrompt,
    },
    AuthNotice {
        flow_id: AuthFlowId,
        notice: AuthNotice,
    },
    AuthFinished {
        flow_id: AuthFlowId,
        provider_id: String,
        result: Result<(), String>,
    },
    ExtensionUiRequested {
        dialog_id: DialogId,
        request: ExtensionUiRequest,
    },
    Notification {
        level: NotificationLevel,
        message: String,
    },
    StatusChanged {
        key: String,
        text: Option<String>,
    },
    HealthChanged(BackendHealth),
    Stopped {
        result: Result<(), String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_debug_output_is_redacted() {
        let secret = SecretValue::from_utf8("token");
        assert_eq!(format!("{secret:?}"), "SecretValue([redacted])");
        assert_eq!(secret.expose().expect("valid UTF-8"), "token");
    }

    #[test]
    fn capabilities_are_explicit_instead_of_implied_by_backend_identity() {
        let capabilities = BackendCapabilities {
            authentication: AuthenticationCapabilities {
                oauth: true,
                api_keys: true,
                ..AuthenticationCapabilities::default()
            },
            ..BackendCapabilities::default()
        };
        assert!(capabilities.authentication.oauth);
        assert!(capabilities.authentication.api_keys);
        assert!(!capabilities.sessions.branching);
    }
}
