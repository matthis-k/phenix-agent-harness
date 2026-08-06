#![forbid(unsafe_code)]

use agent_client_protocol::schema::v1::{ExtRequest, ExtResponse};
use phenix_acp::{
    AcpEndpoint, BackendDefinition, BackendId, DefinitionError, DefinitionFormat,
    DefinitionParseError, Definitions, GatewayError, GatewayEvent, PhenixAcpGateway,
    PhenixConductor, RoleId, RouterId, SessionCommand, SessionNodeId, SessionTreeDefinition,
    SessionTreeId,
};
use phenix_acp_backend::{AcpAgentBackend, AcpBackendConfig, ConfigError as BackendConfigError};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::Path;

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
    cancelled_sessions: BTreeSet<String>,
}

impl ConductorRuntime {
    pub fn new(
        conductor: PhenixConductor,
        definition_id: phenix_acp::DefinitionId,
        root: BootstrapRoot,
    ) -> Result<Self, RuntimeError> {
        if root.objective.trim().is_empty() {
            return Err(RuntimeError::EmptyRootObjective);
        }
        Ok(Self {
            conductor,
            definition_id,
            root,
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
    ) -> Result<ExtResponse, phenix_acp::ConductorError> {
        self.conductor.handle_extension(request)
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

        let mut builder = PhenixAcpGateway::builder().definition(definition)?;
        for backend in self.backends {
            let config = AcpBackendConfig::new(backend.command, cwd.to_path_buf())?;
            let transport = AcpAgentBackend::gateway_transport(config, channel_capacity)?;
            builder = builder.backend(backend.id, transport)?;
        }
        let gateway = definitions.register(builder)?.build()?;
        ConductorRuntime::new(
            PhenixConductor::new(gateway),
            self.definition_id,
            self.root,
        )
        .map_err(BootstrapError::Runtime)
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
pub enum RuntimeError {
    EmptyRootObjective,
    InvalidSessionId {
        session_id: String,
        message: String,
    },
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
            Self::EmptyRootObjective | Self::InvalidSessionId { .. } => None,
        }
    }
}

#[derive(Debug)]
pub enum BootstrapError {
    Decode(serde_json::Error),
    MissingBackends,
    MissingDefinitions,
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
        let bootstrap =
            ConductorBootstrap::from_json(&bootstrap_json("test")).expect("bootstrap");
        let runtime = bootstrap.build(Path::new("/tmp"), 8).expect("runtime");
        assert!(runtime.conductor().gateway().list_trees().trees.is_empty());
    }

    #[test]
    fn every_routed_backend_must_be_configured() {
        let bootstrap =
            ConductorBootstrap::from_json(&bootstrap_json("other")).expect("bootstrap");
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
            "root": {
                "role": "coordinator",
                "objective": "  "
            },
            "backends": [{
                "id": "test",
                "command": "test-agent"
            }],
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
