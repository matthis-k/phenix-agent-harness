use phenix_acp::{
    AcpEndpoint, BackendDefinition, BackendId, DefinitionError, DefinitionFormat, DefinitionId,
    DefinitionParseError, Definitions, GatewayError, PhenixAcpGateway, RoleId, RouterId,
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
    definitions: Vec<DefinitionInput>,
    backend: BackendManifest,
    root: RootManifest,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DefinitionInput {
    Path(String),
    Source {
        source: String,
        #[serde(default)]
        format: Option<DefinitionFormat>,
    },
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
    for (index, input) in manifest.definitions.iter().enumerate() {
        add_definition(
            &mut definitions,
            config_directory,
            input,
            index,
            &mut referenced,
        )?;
    }

    let definition_id = DefinitionId::parse(manifest.definition_id).map_err(|source| {
        AcpConfigLoadError::Identifier {
            field: "definition_id",
            source,
        }
    })?;
    let router_id =
        RouterId::parse(manifest.router).map_err(|source| AcpConfigLoadError::Identifier {
            field: "router",
            source,
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
    let transport = AcpAgentBackend::gateway_transport(transport_config, channel_capacity)
        .map_err(AcpConfigLoadError::Gateway)?;
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
    let root_role =
        RoleId::parse(manifest.root.role).map_err(|source| AcpConfigLoadError::Identifier {
            field: "root.role",
            source,
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

fn add_definition(
    definitions: &mut Definitions,
    config_directory: &Path,
    input: &DefinitionInput,
    index: usize,
    referenced: &mut BTreeSet<PathBuf>,
) -> Result<(), AcpConfigLoadError> {
    match input {
        DefinitionInput::Path(reference) => {
            let path = resolve_source_path(config_directory, reference, referenced)?;
            let format = definition_format_for_path(&path)?;
            let source_text = read_source(&path)?;
            add_source(definitions, &source_text, Some(format)).map_err(|source| {
                AcpConfigLoadError::DefinitionSource {
                    origin: path.display().to_string(),
                    source,
                }
            })
        }
        DefinitionInput::Source { source, format } => {
            let origin = format!("inline definition #{}", index + 1);
            add_source(definitions, source, *format)
                .map_err(|source| AcpConfigLoadError::DefinitionSource { origin, source })
        }
    }
}

fn add_source(
    definitions: &mut Definitions,
    source: &str,
    format: Option<DefinitionFormat>,
) -> Result<(), DefinitionParseError> {
    match format {
        Some(format) => {
            definitions.add_with_format(source, format)?;
        }
        None => {
            definitions.add(source)?;
        }
    }
    Ok(())
}

fn definition_format_for_path(path: &Path) -> Result<DefinitionFormat, AcpConfigLoadError> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .ok_or_else(|| AcpConfigLoadError::UnknownDefinitionFormat(path.to_path_buf()))?;
    DefinitionFormat::from_extension(extension)
        .ok_or_else(|| AcpConfigLoadError::UnknownDefinitionFormat(path.to_path_buf()))
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
    if manifest.definitions.is_empty() {
        return Err(AcpConfigLoadError::MissingDefinitionReferences);
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
        origin: String,
        source: DefinitionParseError,
    },
    UnknownDefinitionFormat(PathBuf),
    InvalidReference(String),
    DuplicateReference(String),
    MissingDefinitionReferences,
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

impl From<DefinitionParseError> for AcpConfigLoadError {
    fn from(source: DefinitionParseError) -> Self {
        Self::DefinitionSource {
            origin: "registered definition".to_owned(),
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
            Self::DefinitionSource { origin, source } => {
                write!(formatter, "invalid definition {origin}: {source}")
            }
            Self::UnknownDefinitionFormat(path) => write!(
                formatter,
                "cannot infer definition format from {}; supported extensions are .md, .markdown, .json, .toml, and .ron",
                path.display()
            ),
            Self::InvalidReference(reference) => write!(
                formatter,
                "invalid definition reference {reference:?}; references must stay inside the configuration directory"
            ),
            Self::DuplicateReference(reference) => {
                write!(formatter, "definition file {reference:?} is referenced more than once")
            }
            Self::MissingDefinitionReferences => {
                formatter.write_str("config.json must contain at least one definition")
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
            Self::UnknownDefinitionFormat(_)
            | Self::InvalidReference(_)
            | Self::DuplicateReference(_)
            | Self::MissingDefinitionReferences
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
    fn path_extensions_select_definition_formats() {
        assert_eq!(
            definition_format_for_path(Path::new("workflow.md")).expect("markdown"),
            DefinitionFormat::Markdown
        );
        assert_eq!(
            definition_format_for_path(Path::new("router.ron")).expect("ron"),
            DefinitionFormat::Ron
        );
        assert!(definition_format_for_path(Path::new("router.yaml")).is_err());
    }

    #[test]
    fn inline_sources_can_use_explicit_or_detected_formats() {
        let workflow = r#"kind = "workflow"
title = "Implementation"
id = "phenix.implement"
[[steps]]
key = "implement"
role = "implementer"
objective = "Implement {objective}"
"#;
        let mut definitions = Definitions::new();
        add_source(&mut definitions, workflow, Some(DefinitionFormat::Toml))
            .expect("explicit TOML");
        assert_eq!(definitions.workflows().len(), 1);
    }

    #[test]
    fn backend_commands_are_split_for_definition_metadata() {
        let command = parse_backend_command("pi-acp --profile mixed").expect("command");
        assert_eq!(command.program, "pi-acp");
        assert_eq!(command.arguments, ["--profile", "mixed"]);
    }
}
