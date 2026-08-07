use agent_client_protocol::schema::v1::{ExtRequest, ExtResponse};
use phenix_acp::{
    AcpMethod, ConfigurationApply, ConfigurationApplyParams, ConfigurationApplyResult,
    ConfigurationDefinitionInput, ConfigurationFormat, ConfigurationGet, ConfigurationGetResult,
    ConfigurationSnapshot, ConfigurationSourceError, DefinitionFormat, GatewayEvent,
    PhenixConductor, SessionCommand,
};
use phenix_conductor::{
    BootstrapBackend, BootstrapDefinition, BootstrapRoot, ConductorBootstrap, ConductorRuntime,
    StandardSession,
};
use serde::Serialize;
use serde_json::value::to_raw_value;
use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const CONFIGURATION_FILE_ENV: &str = "PHENIX_CONFIGURATION_FILE";

/// ACP-process owner for the canonical Phenix configuration and runtime.
///
/// The frontend submits only source descriptors. This type resolves those
/// descriptors, parses and validates the complete configuration, and constructs
/// `ConductorRuntime` inside the Phenix ACP process. Configuration is immutable
/// for the lifetime of this owner so every session tree has one stable runtime
/// configuration.
pub struct ConductorOwner {
    cwd: PathBuf,
    channel_capacity: usize,
    runtime: Option<ConductorRuntime>,
    configuration: Option<ConfigurationSnapshot>,
}

impl ConductorOwner {
    pub fn new(cwd: PathBuf, channel_capacity: usize) -> Result<Self, ConductorOwnerError> {
        if channel_capacity == 0 {
            return Err(ConductorOwnerError::InvalidChannelCapacity);
        }
        let mut owner = Self {
            cwd,
            channel_capacity,
            runtime: None,
            configuration: None,
        };
        if let Some(path) = env::var_os(CONFIGURATION_FILE_ENV).map(PathBuf::from) {
            env::remove_var(CONFIGURATION_FILE_ENV);
            let source = fs::read_to_string(&path).map_err(|source| {
                ConductorOwnerError::ReadConfigurationFile {
                    path: path.clone(),
                    source,
                }
            })?;
            fs::remove_file(&path).map_err(|source| {
                ConductorOwnerError::RemoveConfigurationFile {
                    path: path.clone(),
                    source,
                }
            })?;
            let params =
                serde_json::from_str(&source).map_err(ConductorOwnerError::DecodeConfiguration)?;
            owner.apply_params(params)?;
        }
        Ok(owner)
    }

    pub fn handle_configuration_extension(
        &mut self,
        request: &ExtRequest,
    ) -> Result<Option<ExtResponse>, ConductorOwnerError> {
        match request.method.as_ref() {
            ConfigurationApply::METHOD => self.apply(request).map(Some),
            ConfigurationGet::METHOD => self.get().map(Some),
            _ => Ok(None),
        }
    }

    pub fn handle_auth_extension(
        &mut self,
        request: &ExtRequest,
    ) -> Result<Option<ExtResponse>, ConductorOwnerError> {
        self.runtime_mut()?
            .handle_auth_extension(request)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn handle_extension(
        &mut self,
        request: ExtRequest,
    ) -> Result<ExtResponse, ConductorOwnerError> {
        self.runtime_mut()?
            .handle_extension(request)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn create_standard_session(&mut self) -> Result<StandardSession, ConductorOwnerError> {
        self.runtime_mut()?
            .create_standard_session()
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn execute_standard_session(
        &mut self,
        session_id: &str,
        command: SessionCommand,
    ) -> Result<Vec<GatewayEvent>, ConductorOwnerError> {
        self.runtime_mut()?
            .execute_standard_session(session_id, command)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn cancel_standard_session(
        &mut self,
        session_id: &str,
    ) -> Result<Vec<GatewayEvent>, ConductorOwnerError> {
        self.runtime_mut()?
            .cancel_standard_session(session_id)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn take_standard_session_cancelled(
        &mut self,
        session_id: &str,
    ) -> Result<bool, ConductorOwnerError> {
        Ok(self
            .runtime_mut()?
            .take_standard_session_cancelled(session_id))
    }

    pub fn close_standard_session(&mut self, session_id: &str) -> Result<(), ConductorOwnerError> {
        self.runtime_mut()?
            .close_standard_session(session_id)
            .map_err(|error| ConductorOwnerError::Runtime(error.to_string()))
    }

    pub fn conductor(&self) -> Result<&PhenixConductor, ConductorOwnerError> {
        self.runtime().map(ConductorRuntime::conductor)
    }

    pub fn conductor_mut(&mut self) -> Result<&mut PhenixConductor, ConductorOwnerError> {
        self.runtime_mut().map(ConductorRuntime::conductor_mut)
    }

    fn apply(&mut self, request: &ExtRequest) -> Result<ExtResponse, ConductorOwnerError> {
        let params: ConfigurationApplyParams = serde_json::from_str(request.params.get())
            .map_err(ConductorOwnerError::DecodeConfiguration)?;
        let result = self.apply_params(params)?;
        encode_response(&result)
    }

    fn apply_params(
        &mut self,
        params: ConfigurationApplyParams,
    ) -> Result<ConfigurationApplyResult, ConductorOwnerError> {
        if self.runtime.is_some() {
            return Err(ConductorOwnerError::AlreadyConfigured);
        }
        let source_root = resolve_source_root(&self.cwd, &params.source_root);
        let (bootstrap, snapshot) = build_bootstrap(params, &source_root)?;

        // Build into a local value first. The active owner remains unmodified if
        // any source, parse, validation, backend, or transport construction fails.
        let runtime = bootstrap
            .build(&self.cwd, self.channel_capacity)
            .map_err(|error| ConductorOwnerError::Build(error.to_string()))?;
        let result = ConfigurationApplyResult {
            revision: snapshot.revision,
            definition_id: snapshot.definition_id.clone(),
            router: snapshot.router.clone(),
        };
        self.runtime = Some(runtime);
        self.configuration = Some(snapshot);
        Ok(result)
    }

    fn get(&self) -> Result<ExtResponse, ConductorOwnerError> {
        encode_response(&ConfigurationGetResult {
            active: self.configuration.clone(),
        })
    }

    fn runtime(&self) -> Result<&ConductorRuntime, ConductorOwnerError> {
        self.runtime
            .as_ref()
            .ok_or(ConductorOwnerError::NotConfigured)
    }

    fn runtime_mut(&mut self) -> Result<&mut ConductorRuntime, ConductorOwnerError> {
        self.runtime
            .as_mut()
            .ok_or(ConductorOwnerError::NotConfigured)
    }
}

fn resolve_source_root(cwd: &Path, configured: &Path) -> PathBuf {
    if configured.is_absolute() {
        configured.to_path_buf()
    } else {
        cwd.join(configured)
    }
}

fn build_bootstrap(
    params: ConfigurationApplyParams,
    source_root: &Path,
) -> Result<(ConductorBootstrap, ConfigurationSnapshot), ConductorOwnerError> {
    let input = params.input;
    if input.backends.is_empty() {
        return Err(ConductorOwnerError::MissingBackends);
    }
    if input.definitions.is_empty() {
        return Err(ConductorOwnerError::MissingDefinitions);
    }

    let backend_ids = input
        .backends
        .iter()
        .map(|backend| backend.id.clone())
        .collect::<Vec<_>>();
    let backends = input
        .backends
        .into_iter()
        .map(|backend| {
            Ok(BootstrapBackend {
                id: backend.id,
                command: command_with_environment(backend.command, backend.environment)?,
                environment: BTreeMap::new(),
            })
        })
        .collect::<Result<Vec<_>, ConductorOwnerError>>()?;

    let mut workflow_count = 0usize;
    let mut routing_table_count = 0usize;
    let mut definitions = Vec::with_capacity(input.definitions.len());
    for definition in input.definitions {
        let definition = match definition {
            ConfigurationDefinitionInput::Workflow { source } => {
                workflow_count += 1;
                let loaded = source
                    .load(source_root)
                    .map_err(ConductorOwnerError::Source)?;
                BootstrapDefinition::Workflow {
                    source: loaded.source,
                    format: loaded.format.map(map_format),
                }
            }
            ConfigurationDefinitionInput::RoutingTable { source } => {
                routing_table_count += 1;
                let loaded = source
                    .load(source_root)
                    .map_err(ConductorOwnerError::Source)?;
                BootstrapDefinition::RoutingTable {
                    source: loaded.source,
                    format: loaded.format.map(map_format),
                }
            }
        };
        definitions.push(definition);
    }

    let snapshot = ConfigurationSnapshot {
        revision: 1,
        definition_id: input.definition_id.clone(),
        router: input.router.clone(),
        backend_ids,
        workflow_count,
        routing_table_count,
    };
    let bootstrap = ConductorBootstrap {
        definition_id: input.definition_id,
        router: input.router,
        root: BootstrapRoot {
            role: input.root.role,
            objective: input.root.objective,
        },
        backends,
        definitions,
    };
    Ok((bootstrap, snapshot))
}

fn command_with_environment(
    command: String,
    environment: BTreeMap<String, String>,
) -> Result<String, ConductorOwnerError> {
    if environment.is_empty() {
        return Ok(command);
    }
    let mut words = Vec::with_capacity(environment.len() + 2);
    words.push("env".to_owned());
    for (name, value) in environment {
        if name.is_empty() || name.contains('=') || name.contains('\0') {
            return Err(ConductorOwnerError::InvalidEnvironmentName(name));
        }
        if value.contains('\0') {
            return Err(ConductorOwnerError::InvalidEnvironmentValue(name));
        }
        words.push(shell_quote(&format!("{name}={value}")));
    }
    words.push(command);
    Ok(words.join(" "))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn map_format(format: ConfigurationFormat) -> DefinitionFormat {
    match format {
        ConfigurationFormat::Markdown => DefinitionFormat::Markdown,
        ConfigurationFormat::Json => DefinitionFormat::Json,
        ConfigurationFormat::Toml => DefinitionFormat::Toml,
        ConfigurationFormat::Ron => DefinitionFormat::Ron,
    }
}

fn encode_response<T: Serialize>(value: &T) -> Result<ExtResponse, ConductorOwnerError> {
    let raw = to_raw_value(value).map_err(ConductorOwnerError::EncodeConfiguration)?;
    Ok(ExtResponse::new(Arc::from(raw)))
}

#[derive(Debug)]
pub enum ConductorOwnerError {
    InvalidChannelCapacity,
    NotConfigured,
    AlreadyConfigured,
    MissingBackends,
    MissingDefinitions,
    InvalidEnvironmentName(String),
    InvalidEnvironmentValue(String),
    ReadConfigurationFile { path: PathBuf, source: io::Error },
    RemoveConfigurationFile { path: PathBuf, source: io::Error },
    DecodeConfiguration(serde_json::Error),
    EncodeConfiguration(serde_json::Error),
    Source(ConfigurationSourceError),
    Build(String),
    Runtime(String),
}

impl Display for ConductorOwnerError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidChannelCapacity => {
                formatter.write_str("ACP downstream channel capacity must be greater than zero")
            }
            Self::NotConfigured => formatter.write_str(
                "Phenix ACP is not configured; submit _phenix/config/apply before creating sessions",
            ),
            Self::AlreadyConfigured => formatter.write_str(
                "Phenix ACP configuration is immutable for this runtime; start another runtime for a different configuration",
            ),
            Self::MissingBackends => {
                formatter.write_str("Phenix ACP configuration requires at least one backend")
            }
            Self::MissingDefinitions => formatter
                .write_str("Phenix ACP configuration requires at least one definition source"),
            Self::InvalidEnvironmentName(name) => write!(
                formatter,
                "invalid backend environment variable name {name:?}"
            ),
            Self::InvalidEnvironmentValue(name) => write!(
                formatter,
                "backend environment variable {name:?} contains a NUL byte"
            ),
            Self::ReadConfigurationFile { path, source } => write!(
                formatter,
                "failed to read typed Phenix ACP configuration input {}: {source}",
                path.display()
            ),
            Self::RemoveConfigurationFile { path, source } => write!(
                formatter,
                "failed to remove consumed Phenix ACP configuration input {}: {source}",
                path.display()
            ),
            Self::DecodeConfiguration(error) => {
                write!(formatter, "invalid Phenix ACP configuration request: {error}")
            }
            Self::EncodeConfiguration(error) => {
                write!(formatter, "failed to encode Phenix ACP configuration response: {error}")
            }
            Self::Source(error) => Display::fmt(error, formatter),
            Self::Build(error) => {
                write!(formatter, "failed to construct Phenix ACP configuration: {error}")
            }
            Self::Runtime(error) => formatter.write_str(error),
        }
    }
}

impl Error for ConductorOwnerError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::ReadConfigurationFile { source, .. }
            | Self::RemoveConfigurationFile { source, .. } => Some(source),
            Self::DecodeConfiguration(error) | Self::EncodeConfiguration(error) => Some(error),
            Self::Source(error) => Some(error),
            Self::InvalidChannelCapacity
            | Self::NotConfigured
            | Self::AlreadyConfigured
            | Self::MissingBackends
            | Self::MissingDefinitions
            | Self::InvalidEnvironmentName(_)
            | Self::InvalidEnvironmentValue(_)
            | Self::Build(_)
            | Self::Runtime(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_acp::{
        BackendId, ConfigurationBackendInput, ConfigurationInput, ConfigurationRootInput,
        ConfigurationSource, DefinitionId, RoleId, RouterId, SessionTreeId,
    };

    #[test]
    fn owner_starts_without_a_runtime_configuration() {
        let mut owner = ConductorOwner::new(PathBuf::from("."), 8).expect("owner");
        assert!(matches!(
            owner.create_standard_session(),
            Err(ConductorOwnerError::NotConfigured)
        ));
    }

    #[test]
    fn configuration_input_keeps_paths_unresolved_until_the_owner_builds_it() {
        let input = ConfigurationInput {
            definition_id: DefinitionId::parse("default").expect("definition"),
            router: RouterId::parse("default").expect("router"),
            root: ConfigurationRootInput {
                tree_id: SessionTreeId::parse("root").expect("tree"),
                role: RoleId::parse("root").expect("role"),
                objective: "Help the user".to_owned(),
            },
            backends: vec![ConfigurationBackendInput {
                id: BackendId::parse("pi").expect("backend"),
                command: "pi --mode acp".to_owned(),
                environment: BTreeMap::new(),
            }],
            definitions: vec![ConfigurationDefinitionInput::Workflow {
                source: ConfigurationSource::Path {
                    path: PathBuf::from("workflows/implement.md"),
                },
            }],
        };
        assert!(matches!(
            &input.definitions[0],
            ConfigurationDefinitionInput::Workflow {
                source: ConfigurationSource::Path { path }
            } if path == Path::new("workflows/implement.md")
        ));
    }

    #[test]
    fn backend_environment_is_assembled_inside_the_conductor() {
        let command = command_with_environment(
            "mock-agent --acp".to_owned(),
            BTreeMap::from([(
                "PHENIX_MOCK_ACP_CONFIG".to_owned(),
                "value with spaces and 'quotes'".to_owned(),
            )]),
        )
        .expect("environment command");
        let words = shell_words::split(&command).expect("shell words");
        assert_eq!(words[0], "env");
        assert_eq!(
            words[1],
            "PHENIX_MOCK_ACP_CONFIG=value with spaces and 'quotes'"
        );
        assert_eq!(&words[2..], &["mock-agent", "--acp"]);
    }
}
