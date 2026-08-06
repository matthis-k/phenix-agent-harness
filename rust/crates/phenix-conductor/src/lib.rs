#![forbid(unsafe_code)]

use phenix_acp::{
    AcpEndpoint, BackendDefinition, BackendId, DefinitionError, DefinitionFormat,
    DefinitionParseError, Definitions, GatewayError, PhenixAcpGateway, PhenixConductor, RouterId,
    SessionTreeDefinition,
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
    pub backends: Vec<BootstrapBackend>,
    pub definitions: Vec<BootstrapDefinition>,
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

impl ConductorBootstrap {
    pub fn from_json(source: &str) -> Result<Self, BootstrapError> {
        serde_json::from_str(source).map_err(BootstrapError::Decode)
    }

    pub fn build(
        self,
        cwd: &Path,
        channel_capacity: usize,
    ) -> Result<PhenixConductor, BootstrapError> {
        if channel_capacity == 0 {
            return Err(BootstrapError::InvalidChannelCapacity);
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
        Ok(PhenixConductor::new(gateway))
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
pub enum BootstrapError {
    Decode(serde_json::Error),
    MissingBackends,
    MissingDefinitions,
    MissingRouter(RouterId),
    MissingRoutedBackend {
        router: RouterId,
        backend: BackendId,
    },
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
            Self::MissingBackends
            | Self::MissingDefinitions
            | Self::MissingRouter(_)
            | Self::MissingRoutedBackend { .. }
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

    #[test]
    fn bootstrap_is_language_neutral_and_builds_without_starting_agents() {
        let source = serde_json::json!({
            "definition_id": "definition.test",
            "router": "router.test",
            "backends": [{
                "id": "test",
                "command": "test-agent --stdio"
            }],
            "definitions": [
                { "kind": "routing_table", "source": ROUTER, "format": "markdown" },
                { "kind": "workflow", "source": WORKFLOW, "format": "markdown" }
            ]
        })
        .to_string();
        let bootstrap = ConductorBootstrap::from_json(&source).expect("bootstrap");
        let conductor = bootstrap.build(Path::new("/tmp"), 8).expect("conductor");
        assert!(conductor.gateway().list_trees().trees.is_empty());
    }

    #[test]
    fn every_routed_backend_must_be_configured() {
        let source = serde_json::json!({
            "definition_id": "definition.test",
            "router": "router.test",
            "backends": [{
                "id": "other",
                "command": "other-agent"
            }],
            "definitions": [
                { "kind": "routing_table", "source": ROUTER, "format": "markdown" }
            ]
        })
        .to_string();
        let bootstrap = ConductorBootstrap::from_json(&source).expect("bootstrap");
        assert!(matches!(
            bootstrap.build(Path::new("/tmp"), 8),
            Err(BootstrapError::MissingRoutedBackend { .. })
        ));
    }
}
