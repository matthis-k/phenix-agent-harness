#![forbid(unsafe_code)]

mod auth;

use agent_client_protocol::schema::v1::{ExtRequest, ExtResponse};
use phenix_acp::{
    AcpEndpoint, AcpMethod, AuthenticationCapabilities, BackendAuthMethod, BackendAuthProviderList,
    BackendAuthProviderListResult, BackendAuthProviderSummary, BackendCapabilities,
    BackendCapabilitiesGet, BackendCapabilitiesResult, BackendCommandList,
    BackendCommandListResult, BackendCommandSource, BackendCommandSummary, BackendDefinition,
    BackendId, BackendModelList, BackendModelListResult, BackendModelSummary, BackendTargetParams,
    DefinitionError, DefinitionFormat, DefinitionParseError, Definitions, ExtensionUiCapabilities,
    GatewayError, GatewayEvent, ModelCapabilities, ModelId, PhenixAcpGateway, PhenixConductor,
    PromptCapabilities, ProviderId, ResourceCapabilities, RoleId, RouterId, SessionCapabilities,
    SessionCommand, SessionNodeId, SessionTreeDefinition, SessionTreeId,
};
use phenix_acp_backend::{
    AcpAgentBackend, AcpBackendConfig, AcpGatewayTransport, ConfigError as BackendConfigError,
};
use phenix_runtime_api::{
    AuthMethod, BackendCommand, BackendReply, CommandSource, ModelSummary as RuntimeModelSummary,
};
use serde::Deserialize;
use serde_json::value::to_raw_value;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::Path;
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ConductorBootstrap {
    pub definition_id: phenix_acp::DefinitionId,
    pub router: RouterId,
    pub root: BootstrapRoot,
    pub backends: Vec<BootstrapBackend>,
    pub definitions: Vec<BootstrapDefinition>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BootstrapRoot {
    pub role: RoleId,
    pub objective: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct BootstrapBackend {
    pub id: BackendId,
    pub command: String,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BootstrapDefinition {
    Workflow {
        source: String,
        #[serde(default)]
        format: Option<DefinitionFormat>,
    },
    RoutingTable {
        source: String,
        #[serde(default)]
        format: Option<DefinitionFormat>,
    },
}

pub struct ConductorRuntime {
    conductor: PhenixConductor,
    definition_id: phenix_acp::DefinitionId,
    root: BootstrapRoot,
    backends: BTreeMap<BackendId, AcpGatewayTransport>,
    cancelled_sessions: BTreeSet<String>,
}

impl ConductorRuntime {
    pub fn new(
        conductor: PhenixConductor,
        definition_id: phenix_acp::DefinitionId,
        root: BootstrapRoot,
        backends: BTreeMap<BackendId, AcpGatewayTransport>,
    ) -> Result<Self, RuntimeError> {
        if root.objective.trim().is_empty() {
            return Err(RuntimeError::EmptyRootObjective);
        }
        if backends.is_empty() {
            return Err(RuntimeError::MissingBackends);
        }
        Ok(Self {
            conductor,
            definition_id,
            root,
            backends,
            cancelled_sessions: BTreeSet::new(),
        })
    }

    pub fn conductor(&self) -> &PhenixConductor {
        &self.conductor
    }

    pub fn conductor_mut(&mut self) -> &mut PhenixConductor {
        &mut self.conductor
    }

    pub fn handle_extension(
        &mut self,
        request: ExtRequest,
    ) -> Result<ExtResponse, RuntimeExtensionError> {
        match request.method.as_ref() {
            BackendCapabilitiesGet::METHOD => {
                let params = decode_backend_params::<BackendCapabilitiesGet>(&request)?;
                let capabilities = self.backend_capabilities(&params)?;
                encode_extension_result::<BackendCapabilitiesGet>(&BackendCapabilitiesResult {
                    backend: params.backend,
                    capabilities,
                })
            }
            BackendModelList::METHOD => {
                let params = decode_backend_params::<BackendModelList>(&request)?;
                let models = self.backend_models(&params)?;
                encode_extension_result::<BackendModelList>(&BackendModelListResult {
                    backend: params.backend,
                    models,
                })
            }
            BackendAuthProviderList::METHOD => {
                let params = decode_backend_params::<BackendAuthProviderList>(&request)?;
                let providers = self.backend_auth_providers(&params)?;
                encode_extension_result::<BackendAuthProviderList>(&BackendAuthProviderListResult {
                    backend: params.backend,
                    providers,
                })
            }
            BackendCommandList::METHOD => {
                let params = decode_backend_params::<BackendCommandList>(&request)?;
                let commands = self.backend_commands(&params)?;
                encode_extension_result::<BackendCommandList>(&BackendCommandListResult {
                    backend: params.backend,
                    commands,
                })
            }
            _ => self
                .conductor
                .handle_extension(request)
                .map_err(RuntimeExtensionError::Conductor),
        }
    }

    pub fn create_standard_session(&mut self) -> Result<StandardSession, RuntimeError> {
        let started = self.conductor.gateway_mut().create_tree(
            &self.definition_id,
            self.root.role.clone(),
            self.root.objective.clone(),
        )?;
        Ok(StandardSession {
            session_id: started.tree_id.to_string(),
            tree_id: started.tree_id,
            root_node_id: started.root_node_id,
        })
    }

    pub fn execute_standard_session(
        &mut self,
        session_id: &str,
        command: SessionCommand,
    ) -> Result<Vec<GatewayEvent>, RuntimeError> {
        let binding = self.standard_session(session_id)?;
        self.conductor
            .gateway_mut()
            .execute(&binding.tree_id, &binding.root_node_id, command)
            .map_err(RuntimeError::Gateway)
    }

    pub fn cancel_standard_session(
        &mut self,
        session_id: &str,
    ) -> Result<Vec<GatewayEvent>, RuntimeError> {
        let binding = self.standard_session(session_id)?;
        let events = self
            .conductor
            .gateway_mut()
            .cancel_subtree(&binding.tree_id, &binding.root_node_id)?;
        self.cancelled_sessions.insert(session_id.to_owned());
        Ok(events)
    }

    pub fn take_standard_session_cancelled(&mut self, session_id: &str) -> bool {
        self.cancelled_sessions.remove(session_id)
    }

    pub fn close_standard_session(&mut self, session_id: &str) -> Result<(), RuntimeError> {
        let tree_id = parse_tree_id(session_id)?;
        self.conductor.gateway_mut().close_tree(&tree_id)?;
        self.cancelled_sessions.remove(session_id);
        Ok(())
    }

    pub fn standard_session(&self, session_id: &str) -> Result<StandardSession, RuntimeError> {
        let tree_id = parse_tree_id(session_id)?;
        let snapshot = self.conductor.gateway().snapshot(&tree_id)?;
        Ok(StandardSession {
            session_id: session_id.to_owned(),
            tree_id,
            root_node_id: snapshot.root,
        })
    }

    fn backend_capabilities(
        &self,
        params: &BackendTargetParams,
    ) -> Result<BackendCapabilities, RuntimeExtensionError> {
        let mut control = self.backend_control(params)?;
        let snapshot = control.snapshot()?;
        Ok(map_capabilities(snapshot.capabilities))
    }

    fn backend_models(
        &self,
        params: &BackendTargetParams,
    ) -> Result<Vec<BackendModelSummary>, RuntimeExtensionError> {
        match self
            .backend_control(params)?
            .submit(BackendCommand::ModelList)?
        {
            BackendReply::Models(models) => models.into_iter().map(map_model).collect(),
            reply => Err(RuntimeExtensionError::UnexpectedReply {
                method: BackendModelList::METHOD,
                reply: format!("{reply:?}"),
            }),
        }
    }

    fn backend_auth_providers(
        &self,
        params: &BackendTargetParams,
    ) -> Result<Vec<BackendAuthProviderSummary>, RuntimeExtensionError> {
        match self
            .backend_control(params)?
            .submit(BackendCommand::AuthProviders)?
        {
            BackendReply::AuthProviders(providers) => Ok(providers
                .into_iter()
                .map(|provider| BackendAuthProviderSummary {
                    id: provider.id,
                    display_name: provider.display_name,
                    methods: provider.methods.into_iter().map(map_auth_method).collect(),
                    configured: provider.configured,
                    source: provider.source,
                })
                .collect()),
            reply => Err(RuntimeExtensionError::UnexpectedReply {
                method: BackendAuthProviderList::METHOD,
                reply: format!("{reply:?}"),
            }),
        }
    }

    fn backend_commands(
        &self,
        params: &BackendTargetParams,
    ) -> Result<Vec<BackendCommandSummary>, RuntimeExtensionError> {
        match self
            .backend_control(params)?
            .submit(BackendCommand::CommandList)?
        {
            BackendReply::Commands(commands) => Ok(commands
                .into_iter()
                .map(|command| BackendCommandSummary {
                    name: command.name,
                    description: command.description,
                    source: map_command_source(command.source),
                })
                .collect()),
            reply => Err(RuntimeExtensionError::UnexpectedReply {
                method: BackendCommandList::METHOD,
                reply: format!("{reply:?}"),
            }),
        }
    }

    fn backend_control(
        &self,
        params: &BackendTargetParams,
    ) -> Result<phenix_acp_backend::AcpTreeControl, RuntimeExtensionError> {
        self.conductor.gateway().snapshot(&params.tree_id)?;
        self.backends
            .get(&params.backend)
            .ok_or_else(|| RuntimeExtensionError::UnknownBackend(params.backend.clone()))?
            .control(params.tree_id.clone())
            .map_err(RuntimeExtensionError::Gateway)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StandardSession {
    pub session_id: String,
    pub tree_id: SessionTreeId,
    pub root_node_id: SessionNodeId,
}

fn parse_tree_id(session_id: &str) -> Result<SessionTreeId, RuntimeError> {
    SessionTreeId::parse(session_id).map_err(|source| RuntimeError::InvalidSessionId {
        session_id: session_id.to_owned(),
        message: source.to_string(),
    })
}

impl ConductorBootstrap {
    pub fn from_json(source: &str) -> Result<Self, BootstrapError> {
        serde_json::from_str(source).map_err(BootstrapError::Decode)
    }

    pub fn build(
        self,
        cwd: &Path,
        channel_capacity: usize,
    ) -> Result<ConductorRuntime, BootstrapError> {
        if channel_capacity == 0 {
            return Err(BootstrapError::InvalidChannelCapacity);
        }
        if self.root.objective.trim().is_empty() {
            return Err(BootstrapError::EmptyRootObjective);
        }
        if self.backends.is_empty() {
            return Err(BootstrapError::MissingBackends);
        }
        if self.definitions.is_empty() {
            return Err(BootstrapError::MissingDefinitions);
        }

        let mut definitions = Definitions::new();
        for definition in self.definitions {
            match definition {
                BootstrapDefinition::Workflow { source, format } => match format {
                    Some(format) => {
                        definitions.add_workflow_with_format(&source, format)?;
                    }
                    None => {
                        definitions.add_workflow(&source)?;
                    }
                },
                BootstrapDefinition::RoutingTable { source, format } => match format {
                    Some(format) => {
                        definitions.add_routing_table_with_format(&source, format)?;
                    }
                    None => {
                        definitions.add_routing_table(&source)?;
                    }
                },
            }
        }

        let configured_backends = self
            .backends
            .iter()
            .map(|backend| backend.id.clone())
            .collect::<BTreeSet<_>>();
        if configured_backends.len() != self.backends.len() {
            return Err(BootstrapError::DuplicateBackend);
        }
        let selected_router = definitions
            .routing_tables()
            .find(|router| router.id() == &self.router)
            .ok_or_else(|| BootstrapError::MissingRouter(self.router.clone()))?;
        for rule in selected_router.rules() {
            if !configured_backends.contains(rule.target().backend()) {
                return Err(BootstrapError::MissingRoutedBackend {
                    router: self.router.clone(),
                    backend: rule.target().backend().clone(),
                });
            }
        }

        let workflow_ids = definitions
            .workflows()
            .map(|workflow| workflow.id().clone())
            .collect::<Vec<_>>();
        let mut definition =
            SessionTreeDefinition::builder(self.definition_id.clone(), self.router.clone());
        for backend in &self.backends {
            let command = parse_command(&backend.command)?;
            let endpoint = AcpEndpoint::stdio(
                command.program,
                command.arguments,
                backend.environment.clone(),
            )?;
            definition =
                definition.backend(BackendDefinition::new(backend.id.clone(), endpoint))?;
        }
        for workflow in workflow_ids {
            definition = definition.workflow(workflow)?;
        }
        let definition = definition.build()?;

        let mut transports = BTreeMap::new();
        let mut builder = PhenixAcpGateway::builder().definition(definition)?;
        for backend in self.backends {
            let config = AcpBackendConfig::new(backend.command, cwd.to_path_buf())?;
            let transport = AcpAgentBackend::gateway_transport(config, channel_capacity)?;
            builder = builder.backend(backend.id.clone(), transport.clone())?;
            transports.insert(backend.id, transport);
        }
        let gateway = definitions.register(builder)?.build()?;
        ConductorRuntime::new(
            PhenixConductor::new(gateway),
            self.definition_id,
            self.root,
            transports,
        )
        .map_err(BootstrapError::Runtime)
    }
}

fn decode_backend_params<M: AcpMethod<Params = BackendTargetParams>>(
    request: &ExtRequest,
) -> Result<BackendTargetParams, RuntimeExtensionError> {
    serde_json::from_str(request.params.get()).map_err(|source| RuntimeExtensionError::Decode {
        method: M::METHOD,
        source,
    })
}

fn encode_extension_result<M: AcpMethod>(
    result: &M::Result,
) -> Result<ExtResponse, RuntimeExtensionError> {
    let raw = to_raw_value(result).map_err(|source| RuntimeExtensionError::Encode {
        method: M::METHOD,
        source,
    })?;
    Ok(ExtResponse::new(Arc::from(raw)))
}

fn map_capabilities(value: phenix_runtime_api::BackendCapabilities) -> BackendCapabilities {
    BackendCapabilities {
        prompting: PromptCapabilities {
            steering: value.prompting.steering,
            follow_ups: value.prompting.follow_ups,
            images: value.prompting.images,
            compaction: value.prompting.compaction,
            retry_control: value.prompting.retry_control,
        },
        sessions: SessionCapabilities {
            persistence: value.sessions.persistence,
            switching: value.sessions.switching,
            branching: value.sessions.branching,
            import: value.sessions.import,
            export: value.sessions.export,
            tree: value.sessions.tree,
        },
        authentication: AuthenticationCapabilities {
            provider_listing: value.authentication.provider_listing,
            oauth: value.authentication.oauth,
            api_keys: value.authentication.api_keys,
            terminal: value.authentication.terminal,
            device_code: value.authentication.device_code,
            browser_callback: value.authentication.browser_callback,
            logout: value.authentication.logout,
        },
        models: ModelCapabilities {
            listing: value.models.listing,
            selection: value.models.selection,
            thinking_levels: value.models.thinking_levels,
            virtual_models: value.models.virtual_models,
        },
        resources: ResourceCapabilities {
            commands: value.resources.commands,
            extensions: value.resources.extensions,
            skills: value.resources.skills,
            prompt_templates: value.resources.prompt_templates,
            reload: value.resources.reload,
        },
        extension_ui: ExtensionUiCapabilities {
            selection: value.extension_ui.selection,
            confirmation: value.extension_ui.confirmation,
            text_input: value.extension_ui.text_input,
            secret_input: value.extension_ui.secret_input,
            editor: value.extension_ui.editor,
            notifications: value.extension_ui.notifications,
            status: value.extension_ui.status,
        },
    }
}

fn map_model(value: RuntimeModelSummary) -> Result<BackendModelSummary, RuntimeExtensionError> {
    let provider = ProviderId::parse(value.model.provider).map_err(|error| {
        RuntimeExtensionError::InvalidBackendValue {
            field: "provider",
            message: error.to_string(),
        }
    })?;
    let model = ModelId::parse(value.model.model).map_err(|error| {
        RuntimeExtensionError::InvalidBackendValue {
            field: "model",
            message: error.to_string(),
        }
    })?;
    Ok(BackendModelSummary {
        provider,
        model,
        display_name: value.display_name,
        supports_images: value.supports_images,
        supports_thinking: value.supports_thinking,
    })
}

fn map_auth_method(value: AuthMethod) -> BackendAuthMethod {
    match value {
        AuthMethod::OAuth => BackendAuthMethod::OAuth,
        AuthMethod::ApiKey => BackendAuthMethod::ApiKey,
        AuthMethod::Terminal => BackendAuthMethod::Terminal,
    }
}

fn map_command_source(value: CommandSource) -> BackendCommandSource {
    match value {
        CommandSource::BuiltIn => BackendCommandSource::BuiltIn,
        CommandSource::Extension => BackendCommandSource::Extension,
        CommandSource::Skill => BackendCommandSource::Skill,
        CommandSource::PromptTemplate => BackendCommandSource::PromptTemplate,
    }
}

struct ParsedCommand {
    program: String,
    arguments: Vec<String>,
}

fn parse_command(command: &str) -> Result<ParsedCommand, BootstrapError> {
    let words = shell_words::split(command).map_err(|source| BootstrapError::InvalidCommand {
        command: command.to_owned(),
        source,
    })?;
    let Some((program, arguments)) = words.split_first() else {
        return Err(BootstrapError::EmptyCommand);
    };
    Ok(ParsedCommand {
        program: program.clone(),
        arguments: arguments.to_vec(),
    })
}

#[derive(Debug)]
pub enum RuntimeExtensionError {
    Decode {
        method: &'static str,
        source: serde_json::Error,
    },
    Encode {
        method: &'static str,
        source: serde_json::Error,
    },
    UnknownBackend(BackendId),
    InvalidBackendValue {
        field: &'static str,
        message: String,
    },
    UnexpectedReply {
        method: &'static str,
        reply: String,
    },
    Gateway(GatewayError),
    Conductor(phenix_acp::ConductorError),
}

impl From<GatewayError> for RuntimeExtensionError {
    fn from(error: GatewayError) -> Self {
        Self::Gateway(error)
    }
}

impl Display for RuntimeExtensionError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode { method, source } => {
                write!(formatter, "invalid parameters for {method}: {source}")
            }
            Self::Encode { method, source } => {
                write!(formatter, "failed to encode result for {method}: {source}")
            }
            Self::UnknownBackend(backend) => write!(formatter, "unknown backend {backend}"),
            Self::InvalidBackendValue { field, message } => {
                write!(formatter, "invalid downstream {field}: {message}")
            }
            Self::UnexpectedReply { method, reply } => {
                write!(formatter, "unexpected backend reply for {method}: {reply}")
            }
            Self::Gateway(error) => Display::fmt(error, formatter),
            Self::Conductor(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for RuntimeExtensionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Decode { source, .. } | Self::Encode { source, .. } => Some(source),
            Self::Gateway(error) => Some(error),
            Self::Conductor(error) => Some(error),
            Self::UnknownBackend(_)
            | Self::InvalidBackendValue { .. }
            | Self::UnexpectedReply { .. } => None,
        }
    }
}

#[derive(Debug)]
pub enum RuntimeError {
    EmptyRootObjective,
    MissingBackends,
    InvalidSessionId { session_id: String, message: String },
    Gateway(GatewayError),
}

impl From<GatewayError> for RuntimeError {
    fn from(error: GatewayError) -> Self {
        Self::Gateway(error)
    }
}

impl Display for RuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyRootObjective => {
                formatter.write_str("conductor root objective must not be empty")
            }
            Self::MissingBackends => formatter.write_str("conductor runtime requires a backend"),
            Self::InvalidSessionId {
                session_id,
                message,
            } => write!(
                formatter,
                "standard ACP session ID {session_id:?} is not a Phenix tree ID: {message}"
            ),
            Self::Gateway(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for RuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Gateway(error) => Some(error),
            Self::EmptyRootObjective | Self::MissingBackends | Self::InvalidSessionId { .. } => {
                None
            }
        }
    }
}

#[derive(Debug)]
pub enum BootstrapError {
    Decode(serde_json::Error),
    MissingBackends,
    MissingDefinitions,
    DuplicateBackend,
    MissingRouter(RouterId),
    MissingRoutedBackend {
        router: RouterId,
        backend: BackendId,
    },
    EmptyRootObjective,
    InvalidChannelCapacity,
    EmptyCommand,
    InvalidCommand {
        command: String,
        source: shell_words::ParseError,
    },
    DefinitionParse(DefinitionParseError),
    Definition(DefinitionError),
    Backend(BackendConfigError),
    Gateway(GatewayError),
    Runtime(RuntimeError),
}

impl From<DefinitionParseError> for BootstrapError {
    fn from(error: DefinitionParseError) -> Self {
        Self::DefinitionParse(error)
    }
}

impl From<DefinitionError> for BootstrapError {
    fn from(error: DefinitionError) -> Self {
        Self::Definition(error)
    }
}

impl From<BackendConfigError> for BootstrapError {
    fn from(error: BackendConfigError) -> Self {
        Self::Backend(error)
    }
}

impl From<GatewayError> for BootstrapError {
    fn from(error: GatewayError) -> Self {
        Self::Gateway(error)
    }
}

impl Display for BootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(error) => write!(formatter, "invalid conductor bootstrap JSON: {error}"),
            Self::MissingBackends => formatter.write_str("conductor bootstrap requires a backend"),
            Self::MissingDefinitions => {
                formatter.write_str("conductor bootstrap requires definitions")
            }
            Self::DuplicateBackend => {
                formatter.write_str("conductor bootstrap contains a duplicate backend ID")
            }
            Self::MissingRouter(router) => {
                write!(
                    formatter,
                    "conductor bootstrap selects missing router {router}"
                )
            }
            Self::MissingRoutedBackend { router, backend } => write!(
                formatter,
                "router {router} selects backend {backend}, which is not configured"
            ),
            Self::EmptyRootObjective => {
                formatter.write_str("conductor root objective must not be empty")
            }
            Self::InvalidChannelCapacity => {
                formatter.write_str("conductor channel capacity must be positive")
            }
            Self::EmptyCommand => formatter.write_str("backend command must not be empty"),
            Self::InvalidCommand { command, source } => {
                write!(formatter, "invalid backend command {command:?}: {source}")
            }
            Self::DefinitionParse(error) => Display::fmt(error, formatter),
            Self::Definition(error) => Display::fmt(error, formatter),
            Self::Backend(error) => Display::fmt(error, formatter),
            Self::Gateway(error) => Display::fmt(error, formatter),
            Self::Runtime(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for BootstrapError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Decode(error) => Some(error),
            Self::InvalidCommand { source, .. } => Some(source),
            Self::DefinitionParse(error) => Some(error),
            Self::Definition(error) => Some(error),
            Self::Backend(error) => Some(error),
            Self::Gateway(error) => Some(error),
            Self::Runtime(error) => Some(error),
            Self::MissingBackends
            | Self::MissingDefinitions
            | Self::DuplicateBackend
            | Self::MissingRouter(_)
            | Self::MissingRoutedBackend { .. }
            | Self::EmptyRootObjective
            | Self::InvalidChannelCapacity
            | Self::EmptyCommand => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTER: &str = r#"
# Test routing

```phenix-router
id: router.test
```

## Routes

| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `*` | `*` | `test/provider/model` | test route |
"#;

    const WORKFLOW: &str = r#"
# Test workflow

```phenix-workflow
id: workflow.test
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `work` | | `implementer` | Implement {objective} |
"#;

    fn bootstrap_json(backend: &str) -> String {
        serde_json::json!({
            "definition_id": "definition.test",
            "router": "router.test",
            "root": {
                "role": "coordinator",
                "objective": "coordinate the standard ACP session"
            },
            "backends": [{
                "id": backend,
                "command": "test-agent --stdio"
            }],
            "definitions": [
                { "kind": "routing_table", "source": ROUTER, "format": "markdown" },
                { "kind": "workflow", "source": WORKFLOW, "format": "markdown" }
            ]
        })
        .to_string()
    }

    #[test]
    fn bootstrap_is_language_neutral_and_builds_without_starting_agents() {
        let bootstrap = ConductorBootstrap::from_json(&bootstrap_json("test")).expect("bootstrap");
        let runtime = bootstrap.build(Path::new("/tmp"), 8).expect("runtime");
        assert!(runtime.conductor().gateway().list_trees().trees.is_empty());
    }

    #[test]
    fn every_routed_backend_must_be_configured() {
        let bootstrap = ConductorBootstrap::from_json(&bootstrap_json("other")).expect("bootstrap");
        assert!(matches!(
            bootstrap.build(Path::new("/tmp"), 8),
            Err(BootstrapError::MissingRoutedBackend { .. })
        ));
    }

    #[test]
    fn empty_root_objectives_are_rejected_before_starting_backends() {
        let source = serde_json::json!({
            "definition_id": "definition.test",
            "router": "router.test",
            "root": { "role": "coordinator", "objective": "  " },
            "backends": [{ "id": "test", "command": "test-agent" }],
            "definitions": [
                { "kind": "routing_table", "source": ROUTER, "format": "markdown" }
            ]
        })
        .to_string();
        let bootstrap = ConductorBootstrap::from_json(&source).expect("bootstrap");
        assert!(matches!(
            bootstrap.build(Path::new("/tmp"), 8),
            Err(BootstrapError::EmptyRootObjective)
        ));
    }
}
