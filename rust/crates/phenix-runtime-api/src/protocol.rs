use crate::id::{AuthFlowId, DialogId, ObjectiveId, RunId, SessionEntryId, SessionId, ToolCallId};
use std::collections::BTreeMap;
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
    pub terminal: bool,
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
pub struct SessionModeSummary {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub selected: bool,
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
    Terminal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthProviderSummary {
    pub id: String,
    pub display_name: String,
    pub methods: Vec<AuthMethod>,
    pub configured: bool,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExternalCommand {
    pub program: String,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
}
#[derive(Eq, PartialEq)]
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

#[derive(Debug, Eq, PartialEq)]
pub enum AuthPromptResponse {
    Text(String),
    Secret(SecretValue),
    Selected(String),
    ManualCode(String),
    Cancelled,
}

#[derive(Debug, Eq, PartialEq)]
pub enum ExtensionUiResponse {
    Selected(String),
    Confirmed(bool),
    Text(String),
    Cancelled,
}

#[derive(Debug, Eq, PartialEq)]
pub enum BackendCommand {
    Initialize {
        client: ClientInformation,
    },
    SnapshotRequest,
    PromptSubmit {
        run_id: RunId,
        text: String,
        images: Vec<ImageInput>,
        streaming_behavior: Option<StreamingBehavior>,
    },
    PromptSteer {
        run_id: RunId,
        text: String,
        images: Vec<ImageInput>,
    },
    PromptFollowUp {
        run_id: RunId,
        text: String,
        images: Vec<ImageInput>,
    },
    ExecutionAbort {
        run_id: Option<RunId>,
    },
    SessionCreate {
        parent_session: Option<SessionId>,
    },
    SessionSwitch {
        session_id: SessionId,
    },
    SessionFork {
        session_id: SessionId,
        entry_id: SessionEntryId,
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
    SessionModes {
        run_id: RunId,
    },
    SessionModeSelect {
        run_id: RunId,
        mode_id: String,
    },
    SessionExport {
        session_id: SessionId,
        path: Option<String>,
    },
    ModelList,
    ModelSelect {
        run_id: RunId,
        model: ModelRef,
    },
    ThinkingLevels {
        run_id: RunId,
    },
    ThinkingSelect {
        run_id: RunId,
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
    AuthTerminalFinished {
        flow_id: AuthFlowId,
        success: bool,
        message: Option<String>,
    },
    AuthLogout {
        provider_id: String,
    },
    CompactionStart {
        run_id: RunId,
        instructions: Option<String>,
    },
    CompactionAbort {
        run_id: RunId,
    },
    RetryConfigure {
        run_id: RunId,
        enabled: bool,
    },
    RetryAbort {
        run_id: RunId,
    },
    CommandList,
    CommandInvoke {
        run_id: RunId,
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
    Sessions(Vec<PersistedSessionSummary>),
    Runs(Vec<RunSummary>),
    SessionTree(PersistedSessionTreeSnapshot),
    SessionModes(Vec<SessionModeSummary>),
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
    pub root_run: Option<RunId>,
    pub selected_run: Option<RunId>,
    pub sessions: Vec<PersistedSessionSummary>,
    pub runs: Vec<RunSummary>,
    pub objectives: Vec<ObjectiveSummary>,
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
pub struct PersistedSessionSummary {
    pub id: SessionId,
    pub name: Option<String>,
    pub session_file: Option<String>,
    pub cwd: Option<String>,
    pub root_run_id: Option<RunId>,
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionEntryKind {
    User,
    Assistant,
    Tool,
    Compaction,
    ModelChange,
    ThinkingChange,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionEntrySummary {
    pub id: SessionEntryId,
    pub parent: Option<SessionEntryId>,
    pub kind: SessionEntryKind,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistedSessionTreeSnapshot {
    pub session_id: SessionId,
    pub leaf_entry: Option<SessionEntryId>,
    pub entries: Vec<SessionEntrySummary>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunKind {
    Root,
    Agent,
    Workflow,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunState {
    Created,
    Starting,
    Running,
    Waiting,
    Completing,
    Completed,
    Failed,
    Cancelled,
    Orphaned,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunOutcome {
    Success,
    Failure {
        code: String,
        message: String,
        retryable: bool,
    },
    Cancelled {
        reason: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunSummary {
    pub id: RunId,
    pub parent: Option<RunId>,
    pub kind: RunKind,
    pub definition_id: String,
    pub display_name: String,
    pub state: RunState,
    pub persisted_session: Option<SessionId>,
    pub session_file: Option<String>,
    pub model: Option<ModelRef>,
    pub thinking_level: Option<ThinkingLevel>,
    pub difficulty: Option<String>,
    pub budget: Option<String>,
    pub pending_messages: usize,
    pub outcome: Option<RunOutcome>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObjectiveSource {
    User,
    Discovered,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObjectiveState {
    NotStarted,
    WorkInProgress,
    Done,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObjectiveSummary {
    pub id: ObjectiveId,
    pub root_run_id: RunId,
    pub parent: Option<ObjectiveId>,
    pub created_by_run_id: RunId,
    pub title: String,
    pub description: Option<String>,
    pub source: ObjectiveSource,
    pub state: ObjectiveState,
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
    pub run_id: RunId,
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
    PersistedSessionChanged(PersistedSessionSummary),
    RunChanged(RunSummary),
    ObjectiveChanged(ObjectiveSummary),
    TranscriptAppended(TranscriptBlock),
    TranscriptUpdated(TranscriptBlock),
    ToolStarted {
        run_id: RunId,
        tool_call_id: ToolCallId,
        tool_name: String,
        raw_input_json: String,
        input_summary: String,
    },
    ToolUpdated {
        run_id: RunId,
        tool_call_id: ToolCallId,
        output: String,
    },
    ToolFinished {
        run_id: RunId,
        tool_call_id: ToolCallId,
        outcome: ToolExecutionOutcome,
        output_summary: String,
    },
    QueueChanged {
        run_id: RunId,
        steering: Vec<String>,
        follow_ups: Vec<String>,
    },
    ExternalCommandRequested {
        flow_id: AuthFlowId,
        command: ExternalCommand,
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

    #[test]
    fn run_and_persisted_session_state_are_not_collapsed() {
        let snapshot = RuntimeSnapshot {
            capabilities: BackendCapabilities::default(),
            health: BackendHealth::Ready,
            active_session: Some(SessionId::parse("session-1").expect("valid session")),
            root_run: Some(RunId::parse("run-root").expect("valid run")),
            selected_run: Some(RunId::parse("run-child").expect("valid run")),
            sessions: Vec::new(),
            runs: Vec::new(),
            objectives: Vec::new(),
        };
        assert_ne!(
            snapshot.active_session.expect("session").as_str(),
            snapshot.selected_run.expect("run").as_str()
        );
    }
}
