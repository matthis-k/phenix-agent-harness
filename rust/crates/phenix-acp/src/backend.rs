use crate::{AcpMethod, BackendId, ModelId, ProviderId, SessionTreeId};
use serde::{Deserialize, Serialize};

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

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct BackendCapabilities {
    pub prompting: PromptCapabilities,
    pub sessions: SessionCapabilities,
    pub authentication: AuthenticationCapabilities,
    pub models: ModelCapabilities,
    pub resources: ResourceCapabilities,
    pub extension_ui: ExtensionUiCapabilities,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct PromptCapabilities {
    pub steering: bool,
    pub follow_ups: bool,
    pub images: bool,
    pub compaction: bool,
    pub retry_control: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionCapabilities {
    pub persistence: bool,
    pub switching: bool,
    pub branching: bool,
    pub import: bool,
    pub export: bool,
    pub tree: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct AuthenticationCapabilities {
    pub provider_listing: bool,
    pub oauth: bool,
    pub api_keys: bool,
    pub terminal: bool,
    pub device_code: bool,
    pub browser_callback: bool,
    pub logout: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub listing: bool,
    pub selection: bool,
    pub thinking_levels: bool,
    pub virtual_models: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResourceCapabilities {
    pub commands: bool,
    pub extensions: bool,
    pub skills: bool,
    pub prompt_templates: bool,
    pub reload: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ExtensionUiCapabilities {
    pub selection: bool,
    pub confirmation: bool,
    pub text_input: bool,
    pub secret_input: bool,
    pub editor: bool,
    pub notifications: bool,
    pub status: bool,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_discovery_methods_are_backend_scoped() {
        assert_eq!(
            BackendCapabilitiesGet::METHOD,
            "_phenix/backend/capabilities/get"
        );
        assert_eq!(BackendModelList::METHOD, "_phenix/backend/model/list");
        assert_eq!(
            BackendAuthProviderList::METHOD,
            "_phenix/backend/auth_provider/list"
        );
        assert_eq!(BackendCommandList::METHOD, "_phenix/backend/command/list");
    }
}
