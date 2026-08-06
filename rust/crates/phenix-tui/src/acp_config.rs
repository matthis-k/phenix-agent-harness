use phenix_acp::{
    AcpEndpoint, BackendDefinition, BackendId, DefinitionError, DefinitionId,
    DefinitionSourceError, Definitions, GatewayError, PhenixAcpGateway, RoleId, RouterId,
    SessionTreeDefinition, SessionTreeId,
};
use phenix_acp_backend::{
    AcpAgentBackend, AcpBackendConfig, ConfigError as BackendConfigError, GatewayAgentBackend,
};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

const MANIFEST_NAME: &str = "config.json";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    definition_id: String,
    router: String,
    #[serde(default)]
    workflows: Vec<String>,
    routing_tables: Vec<String>,
    backend: BackendManifest,
    root: RootManifest,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackendManifest {
    id: String,
    command: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RootManifest {
    tree_id: String,
    role: String,
    objective: String,
}

pub fn load_acp_backend(
    config_directory: &Path,
    cwd: &Path,
    channel_capacity: usize,
) -> Result<GatewayAgentBackend, AcpConfigLoadError> {
    let manifest_path = config_directory.join(MANIFEST_NAME);
    let manifest_source = read_source(&manifest_path)?;
    let manifest: Manifest = serde_json::from_str(&manifest_source).map_err(|source| {
        AcpConfigLoadError::DecodeManifest {
            path: manifest_path,
            source,
        }
    })?;
    validate_manifest(&manifest)?;

    let backend_id = BackendId::parse(manifest.backend.id.clone()).map_err(|source| {
        AcpConfigLoadError::Identifier {
            field: "backend.id",
            source,
        }
    })?;
    let command = parse_backend_command(&manifest.backend.command)?;

    let mut definitions = Definitions::new();
    let mut referenced = BTreeSet::new();
    for reference in &manifest.workflows {
        let path = resolve_source_path(config_directory, reference, &mut referenced)?;
        let source_text = read_source(&path)?;
        definitions
            .add_workflow(&source_text)
            .map_err(|source| AcpConfigLoadError::DefinitionSource { path, source })?;
    }
    for reference in &manifest.routing_tables {
        let path = resolve_source_path(config_directory, reference, &mut referenced)?;
        let source_text = read_source(&path)?;
        definitions
            .add_routing_table(&source_text)
            .map_err(|source| AcpConfigLoadError::DefinitionSource { path, source })?;
    }

    let definition_id = DefinitionId::parse(manifest.definition_id).map_err(|source| {
        AcpConfigLoadError::Identifier {
            field: "definition_id",
            source,
        }
    })?;
    let router_id = RouterId::parse(manifest.router).map_err(|source| {
        AcpConfigLoadError::Identifier {
            field: "router",
            source,
        }
    })?;
    let selected_router = definitions
        .routing_tables()
        .find(|router| router.id() == &router_id)
        .ok_or_else(|| AcpConfigLoadError::MissingRoutingTable(router_id.clone()))?;
    for rule in selected_router.rules() {
        if rule.target().backend() != &backend_id {
            return Err(AcpConfigLoadError::UnsupportedBackendTarget {
                router: router_id.clone(),
                configured: backend_id.clone(),
                selected: rule.target().backend().clone(),
            });
        }
    }

    let endpoint = AcpEndpoint::stdio(
        command.program.clone(),
        command.arguments.clone(),
        BTreeMap::new(),
    )?;
    let mut tree_definition = SessionTreeDefinition::builder(definition_id.clone(), router_id)
        .backend(BackendDefinition::new(backend_id.clone(), endpoint))?;
    for workflow in definitions.workflows() {
        tree_definition = tree_definition.workflow(workflow.id().clone())?;
    }
    let tree_definition = tree_definition.build()?;

    let transport_config = AcpBackendConfig::new(manifest.backend.command, cwd)?;
    let transport =
        AcpAgentBackend::gateway_transport(transport_config, channel_capacity).map_err(
            AcpConfigLoadError::Gateway,
        )?;
    let builder = PhenixAcpGateway::builder()
        .definition(tree_definition)?
        .backend(backend_id, transport.clone())?;
    let gateway = definitions.register(builder)?.build()?;

    let tree_id = SessionTreeId::parse(manifest.root.tree_id).map_err(|source| {
        AcpConfigLoadError::Identifier {
            field: "root.tree_id",
            source,
        }
    })?;
    let root_role = RoleId::parse(manifest.root.role).map_err(|source| {
        AcpConfigLoadError::Identifier {
            field: "root.role",
            source,
        }
    })?;

    Ok(GatewayAgentBackend::new(
        gateway,
        transport,
        definition_id,
        tree_id,
        root_role,
        manifest.root.objective,
    ))
}

struct BackendCommand {
    program: String,
    arguments: Vec<String>,
}

fn parse_backend_command(command: &str) -> Result<BackendCommand, AcpConfigLoadError> {
    let words = shell_words::split(command).map_err(|source| {
        AcpConfigLoadError::InvalidBackendCommand {
            command: command.to_owned(),
            source,
        }
    })?;
    let Some((program, arguments)) = words.split_first() else {
        return Err(AcpConfigLoadError::EmptyBackendCommand);
    };
    Ok(BackendCommand {
        program: program.clone(),
        arguments: arguments.to_vec(),
    })
}

fn validate_manifest(manifest: &Manifest) -> Result<(), AcpConfigLoadError> {
    if manifest.routing_tables.is_empty() {
        return Err(AcpConfigLoadError::MissingRoutingTableReferences);
    }
    if manifest.backend.command.trim().is_empty() {
        return Err(AcpConfigLoadError::EmptyBackendCommand);
    }
    if manifest.root.objective.trim().is_empty() {
        return Err(AcpConfigLoadError::EmptyRootObjective);
    }
    Ok(())
}

fn resolve_source_path(
    config_directory: &Path,
    reference: &str,
    referenced: &mut BTreeSet<PathBuf>,
) -> Result<PathBuf, AcpConfigLoadError> {
    let relative = Path::new(reference);
    if reference.trim().is_empty()
        || relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AcpConfigLoadError::InvalidReference(reference.to_owned()));
    }
    let path = config_directory.join(relative);
    if !referenced.insert(path.clone()) {
        return Err(AcpConfigLoadError::DuplicateReference(reference.to_owned()));
    }
    Ok(path)
}

fn read_source(path: &Path) -> Result<String, AcpConfigLoadError> {
    fs::read_to_string(path).map_err(|source| AcpConfigLoadError::Read {
        path: path.to_path_buf(),
        source,
    })
}

#[derive(Debug)]
pub enum AcpConfigLoadError {
    Read {
        path: PathBuf,
        source: io::Error,
    },
    DecodeManifest {
        path: PathBuf,
        source: serde_json::Error,
    },
    Identifier {
        field: &'static str,
        source: phenix_acp::IdError,
    },
    DefinitionSource {
        path: PathBuf,
        source: DefinitionSourceError,
    },
    InvalidReference(String),
    DuplicateReference(String),
    MissingRoutingTableReferences,
    MissingRoutingTable(RouterId),
    UnsupportedBackendTarget {
        router: RouterId,
        configured: BackendId,
        selected: BackendId,
    },
    EmptyBackendCommand,
    InvalidBackendCommand {
        command: String,
        source: shell_words::ParseError,
    },
    EmptyRootObjective,
    Definition(DefinitionError),
    BackendConfig(BackendConfigError),
    Gateway(GatewayError),
}

impl From<DefinitionError> for AcpConfigLoadError {
    fn from(source: DefinitionError) -> Self {
        Self::Definition(source)
    }
}

impl From<BackendConfigError> for AcpConfigLoadError {
    fn from(source: BackendConfigError) -> Self {
        Self::BackendConfig(source)
    }
}

impl From<GatewayError> for AcpConfigLoadError {
    fn from(source: GatewayError) -> Self {
        Self::Gateway(source)
    }
}

impl From<DefinitionSourceError> for AcpConfigLoadError {
    fn from(source: DefinitionSourceError) -> Self {
        Self::DefinitionSource {
            path: PathBuf::from("<registered definition>"),
            source,
        }
    }
}

impl Display for AcpConfigLoadError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, source } => {
                write!(formatter, "failed to read {}: {source}", path.display())
            }
            Self::DecodeManifest { path, source } => {
                write!(formatter, "failed to decode {}: {source}", path.display())
            }
            Self::Identifier { field, source } => {
                write!(formatter, "invalid config.json field {field}: {source}")
            }
            Self::DefinitionSource { path, source } => {
                write!(formatter, "invalid definition {}: {source}", path.display())
            }
            Self::InvalidReference(reference) => write!(
                formatter,
                "invalid definition reference {reference:?}; references must stay inside the configuration directory"
            ),
            Self::DuplicateReference(reference) => {
                write!(formatter, "definition file {reference:?} is referenced more than once")
            }
            Self::MissingRoutingTableReferences => {
                formatter.write_str("config.json must reference at least one routing table")
            }
            Self::MissingRoutingTable(router) => {
                write!(formatter, "config.json selects missing routing table {router}")
            }
            Self::UnsupportedBackendTarget {
                router,
                configured,
                selected,
            } => write!(
                formatter,
                "routing table {router} selects backend {selected}, but this frontend tree is configured for backend {configured}"
            ),
            Self::EmptyBackendCommand => {
                formatter.write_str("config.json backend.command must not be empty")
            }
            Self::InvalidBackendCommand { command, source } => {
                write!(formatter, "invalid backend command {command:?}: {source}")
            }
            Self::EmptyRootObjective => {
                formatter.write_str("config.json root.objective must not be empty")
            }
            Self::Definition(source) => Display::fmt(source, formatter),
            Self::BackendConfig(source) => Display::fmt(source, formatter),
            Self::Gateway(source) => Display::fmt(source, formatter),
        }
    }
}

impl Error for AcpConfigLoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Read { source, .. } => Some(source),
            Self::DecodeManifest { source, .. } => Some(source),
            Self::Identifier { source, .. } => Some(source),
            Self::DefinitionSource { source, .. } => Some(source),
            Self::InvalidBackendCommand { source, .. } => Some(source),
            Self::Definition(source) => Some(source),
            Self::BackendConfig(source) => Some(source),
            Self::Gateway(source) => Some(source),
            Self::InvalidReference(_)
            | Self::DuplicateReference(_)
            | Self::MissingRoutingTableReferences
            | Self::MissingRoutingTable(_)
            | Self::UnsupportedBackendTarget { .. }
            | Self::EmptyBackendCommand
            | Self::EmptyRootObjective => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_must_remain_below_the_configuration_directory() {
        let root = Path::new("/config/phenix-acp");
        let mut referenced = BTreeSet::new();
        assert_eq!(
            resolve_source_path(root, "workflows/implement.md", &mut referenced)
                .expect("relative source"),
            root.join("workflows/implement.md")
        );
        assert!(resolve_source_path(root, "../secret", &mut referenced).is_err());
        assert!(resolve_source_path(root, "/absolute", &mut referenced).is_err());
    }

    #[test]
    fn duplicate_file_references_are_rejected_before_reading() {
        let root = Path::new("/config/phenix-acp");
        let mut referenced = BTreeSet::new();
        resolve_source_path(root, "workflow.md", &mut referenced).expect("first reference");
        assert!(resolve_source_path(root, "workflow.md", &mut referenced).is_err());
    }

    #[test]
    fn backend_commands_are_split_for_definition_metadata() {
        let command = parse_backend_command("pi-acp --profile mixed").expect("command");
        assert_eq!(command.program, "pi-acp");
        assert_eq!(command.arguments, ["--profile", "mixed"]);
    }
}
