use crate::{AcpMethod, BackendId, ModelId, ProviderId, SessionTreeId};
pub use phenix_runtime_api::{
    AuthenticationCapabilities, BackendCapabilities, ExtensionUiCapabilities, ModelCapabilities,
    PromptCapabilities, ResourceCapabilities, SessionCapabilities,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendTargetParams {
    pub tree_id: SessionTreeId,
    pub backend: BackendId,
}

pub struct BackendCapabilitiesGet;

impl AcpMethod for BackendCapabilitiesGet {
    const METHOD: &'static str = "_phenix/backend/capabilities/get";
    type Params = BackendTargetParams;
    type Result = BackendCapabilitiesResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendCapabilitiesResult {
    pub backend: BackendId,
    pub capabilities: BackendCapabilities,
}

pub struct BackendModelList;

impl AcpMethod for BackendModelList {
    const METHOD: &'static str = "_phenix/backend/model/list";
    type Params = BackendTargetParams;
    type Result = BackendModelListResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendModelListResult {
    pub backend: BackendId,
    pub models: Vec<BackendModelSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendModelSummary {
    pub provider: ProviderId,
    pub model: ModelId,
    pub display_name: String,
    pub supports_images: bool,
    pub supports_thinking: bool,
}

pub struct BackendAuthProviderList;

impl AcpMethod for BackendAuthProviderList {
    const METHOD: &'static str = "_phenix/backend/auth_provider/list";
    type Params = BackendTargetParams;
    type Result = BackendAuthProviderListResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthProviderListResult {
    pub backend: BackendId,
    pub providers: Vec<BackendAuthProviderSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthProviderSummary {
    pub id: String,
    pub display_name: String,
    pub methods: Vec<BackendAuthMethod>,
    pub configured: bool,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendAuthMethod {
    OAuth,
    ApiKey,
    Terminal,
}

pub struct BackendAuthStart;

impl AcpMethod for BackendAuthStart {
    const METHOD: &'static str = "_phenix/backend/auth/start";
    type Params = BackendAuthStartParams;
    type Result = BackendEventBatch;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthStartParams {
    pub tree_id: SessionTreeId,
    pub backend: BackendId,
    pub provider_id: String,
    pub method: BackendAuthMethod,
}

pub struct BackendAuthRespond;

impl AcpMethod for BackendAuthRespond {
    const METHOD: &'static str = "_phenix/backend/auth/respond";
    type Params = BackendAuthRespondParams;
    type Result = BackendEventBatch;
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthRespondParams {
    pub tree_id: SessionTreeId,
    pub backend: BackendId,
    pub flow_id: String,
    pub response: BackendAuthResponse,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendAuthResponse {
    Text { text: String },
    Secret { secret: String },
    Selected { option_id: String },
    ManualCode { code: String },
    Cancelled,
}

pub struct BackendAuthCancel;

impl AcpMethod for BackendAuthCancel {
    const METHOD: &'static str = "_phenix/backend/auth/cancel";
    type Params = BackendAuthCancelParams;
    type Result = BackendEventBatch;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthCancelParams {
    pub tree_id: SessionTreeId,
    pub backend: BackendId,
    pub flow_id: String,
}

pub struct BackendAuthTerminalFinished;

impl AcpMethod for BackendAuthTerminalFinished {
    const METHOD: &'static str = "_phenix/backend/auth/terminal_finished";
    type Params = BackendAuthTerminalFinishedParams;
    type Result = BackendEventBatch;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthTerminalFinishedParams {
    pub tree_id: SessionTreeId,
    pub backend: BackendId,
    pub flow_id: String,
    pub success: bool,
    pub message: Option<String>,
}

pub struct BackendAuthLogout;

impl AcpMethod for BackendAuthLogout {
    const METHOD: &'static str = "_phenix/backend/auth/logout";
    type Params = BackendAuthLogoutParams;
    type Result = BackendEventBatch;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthLogoutParams {
    pub tree_id: SessionTreeId,
    pub backend: BackendId,
    pub provider_id: String,
}

pub struct BackendEventPoll;

impl AcpMethod for BackendEventPoll {
    const METHOD: &'static str = "_phenix/backend/event/poll";
    type Params = BackendTargetParams;
    type Result = BackendEventBatch;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendEventBatch {
    pub backend: BackendId,
    pub events: Vec<BackendControlEvent>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendControlEvent {
    ExternalCommandRequested {
        flow_id: String,
        command: BackendExternalCommand,
    },
    AuthPromptRequested {
        flow_id: String,
        prompt: BackendAuthPrompt,
    },
    AuthNotice {
        flow_id: String,
        notice: BackendAuthNotice,
    },
    AuthFinished {
        flow_id: String,
        provider_id: String,
        error: Option<String>,
    },
    HealthChanged {
        health: BackendHealth,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendExternalCommand {
    pub program: String,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendAuthPrompt {
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
        options: Vec<BackendAuthPromptOption>,
    },
    ManualCode {
        message: String,
        placeholder: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthPromptOption {
    pub id: String,
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendAuthNotice {
    Information {
        message: String,
        links: Vec<BackendAuthLink>,
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendAuthLink {
    pub url: String,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BackendHealth {
    Starting,
    Ready,
    Degraded { message: String },
    Failed { message: String },
    Stopped,
}

pub struct BackendCommandList;

impl AcpMethod for BackendCommandList {
    const METHOD: &'static str = "_phenix/backend/command/list";
    type Params = BackendTargetParams;
    type Result = BackendCommandListResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendCommandListResult {
    pub backend: BackendId,
    pub commands: Vec<BackendCommandSummary>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendCommandSummary {
    pub name: String,
    pub description: Option<String>,
    pub source: BackendCommandSource,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendCommandSource {
    BuiltIn,
    Extension,
    Skill,
    PromptTemplate,
}
