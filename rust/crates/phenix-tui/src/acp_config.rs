use phenix_acp::{
    AcpEndpoint, BackendDefinition, BackendId, DefinitionError, DefinitionFormat,
    DefinitionParseError, Definitions, GatewayError, PhenixAcpGateway, RouterId,
    SessionTreeDefinition,
};
use phenix_acp_backend::{
    AcpAgentBackend, AcpBackendConfig, ConfigError as BackendConfigError, GatewayAgentBackend,
};
use phenix_ui_lua::{AcpApplicationConfig, AcpDefinitionInput, AcpDefinitionSource};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

pub fn load_acp_backend(
    config_directory: &Path,
    config: &AcpApplicationConfig,
    cwd: &Path,
    channel_capacity: usize,
) -> Result<GatewayAgentBackend, AcpConfigLoadError> {
    validate_config(config)?;

    let backend_id = config.backend().id().clone();
    let command = parse_backend_command(config.backend().command())?;

    let mut definitions = Definitions::new();
    let mut referenced = BTreeSet::new();
    for input in config.definitions() {
        add_definition(&mut definitions, config_directory, input, &mut referenced)?;
    }

    let router_id = config.router().clone();
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
    let mut tree_definition =
        SessionTreeDefinition::builder(config.definition_id().clone(), router_id)
            .backend(BackendDefinition::new(backend_id.clone(), endpoint))?;
    for workflow in definitions.workflows() {
        tree_definition = tree_definition.workflow(workflow.id().clone())?;
    }
    let tree_definition = tree_definition.build()?;

    let transport_config = AcpBackendConfig::new(config.backend().command().to_owned(), cwd)?;
    let transport = AcpAgentBackend::gateway_transport(transport_config, channel_capacity)
        .map_err(AcpConfigLoadError::Gateway)?;
    let builder = PhenixAcpGateway::builder()
        .definition(tree_definition)?
        .backend(backend_id, transport.clone())?;
    let gateway = definitions.register(builder)?.build()?;

    Ok(GatewayAgentBackend::new(
        gateway,
        transport,
        config.definition_id().clone(),
        config.root().tree_id().clone(),
        config.root().role().clone(),
        config.root().objective().to_owned(),
    ))
}

fn add_definition(
    definitions: &mut Definitions,
    config_directory: &Path,
    input: &AcpDefinitionInput,
    referenced: &mut BTreeSet<PathBuf>,
) -> Result<(), AcpConfigLoadError> {
    match input {
        AcpDefinitionInput::Workflow(source) => {
            let (source, format, origin) =
                load_definition_source(config_directory, source, referenced)?;
            match format {
                Some(format) => definitions.add_workflow_with_format(&source, format),
                None => definitions.add_workflow(&source),
            }
            .map(|_| ())
            .map_err(|source| AcpConfigLoadError::DefinitionSource { origin, source })
        }
        AcpDefinitionInput::RoutingTable(source) => {
            let (source, format, origin) =
                load_definition_source(config_directory, source, referenced)?;
            match format {
                Some(format) => definitions.add_routing_table_with_format(&source, format),
                None => definitions.add_routing_table(&source),
            }
            .map(|_| ())
            .map_err(|source| AcpConfigLoadError::DefinitionSource { origin, source })
        }
    }
}

fn load_definition_source(
    config_directory: &Path,
    input: &AcpDefinitionSource,
    referenced: &mut BTreeSet<PathBuf>,
) -> Result<(String, Option<DefinitionFormat>, String), AcpConfigLoadError> {
    match input {
        AcpDefinitionSource::Path(reference) => {
            let path = resolve_source_path(config_directory, reference, referenced)?;
            let format = definition_format_for_path(&path)?;
            let source = read_source(&path)?;
            let origin = path.display().to_string();
            Ok((source, Some(format), origin))
        }
        AcpDefinitionSource::Inline { source, format } => {
            Ok((source.clone(), *format, "inline Lua definition".to_owned()))
        }
    }
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

fn validate_config(config: &AcpApplicationConfig) -> Result<(), AcpConfigLoadError> {
    if config.definitions().is_empty() {
        return Err(AcpConfigLoadError::MissingDefinitionReferences);
    }
    Ok(())
}

fn resolve_source_path(
    config_directory: &Path,
    reference: &Path,
    referenced: &mut BTreeSet<PathBuf>,
) -> Result<PathBuf, AcpConfigLoadError> {
    if reference.as_os_str().is_empty()
        || reference.is_absolute()
        || reference.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AcpConfigLoadError::InvalidReference(
            reference.display().to_string(),
        ));
    }
    let path = config_directory.join(reference);
    if !referenced.insert(path.clone()) {
        return Err(AcpConfigLoadError::DuplicateReference(
            reference.display().to_string(),
        ));
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

impl Display for AcpConfigLoadError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Read { path, source } => {
                write!(formatter, "failed to read {}: {source}", path.display())
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
                "invalid definition reference {reference:?}; references must stay inside the Phenix Harness configuration directory"
            ),
            Self::DuplicateReference(reference) => {
                write!(formatter, "definition file {reference:?} is registered more than once")
            }
            Self::MissingDefinitionReferences => {
                formatter.write_str("the Lua configuration must register at least one definition")
            }
            Self::MissingRoutingTable(router) => {
                write!(formatter, "the Lua configuration selects missing routing table {router}")
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
                formatter.write_str("phenix.acp backend command must not be empty")
            }
            Self::InvalidBackendCommand { command, source } => {
                write!(formatter, "invalid backend command {command:?}: {source}")
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
            | Self::EmptyBackendCommand => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_must_remain_below_the_application_configuration_directory() {
        let root = Path::new("/config/phenix-harness");
        let mut referenced = BTreeSet::new();
        assert_eq!(
            resolve_source_path(root, Path::new("workflows/implement.md"), &mut referenced)
                .expect("relative source"),
            root.join("workflows/implement.md")
        );
        assert!(resolve_source_path(root, Path::new("../secret"), &mut referenced).is_err());
        assert!(resolve_source_path(root, Path::new("/absolute"), &mut referenced).is_err());
    }

    #[test]
    fn duplicate_file_references_are_rejected_before_reading() {
        let root = Path::new("/config/phenix-harness");
        let mut referenced = BTreeSet::new();
        resolve_source_path(root, Path::new("workflow.md"), &mut referenced)
            .expect("first reference");
        assert!(resolve_source_path(root, Path::new("workflow.md"), &mut referenced).is_err());
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
}
