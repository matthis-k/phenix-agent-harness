use phenix_acp::{
    encode_extension_request, ConfigurationApply, ConfigurationApplyParams,
    ConfigurationBackendInput, ConfigurationDefinitionInput, ConfigurationFormat,
    ConfigurationInput, ConfigurationSource, ConfigurationStandardSessionInput, DefinitionFormat,
    ToolConfiguration,
};
use phenix_acp_backend::{AcpAgentBackend, AcpBackendConfig, ConfigError as BackendConfigError};
use phenix_ui_lua::{AcpApplicationConfig, AcpDefinitionInput, AcpDefinitionSource};
use std::env;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::Path;

const CONDUCTOR_COMMAND_ENV: &str = "PHENIX_CONDUCTOR_COMMAND";

/// Build a standard ACP client for a bare Phenix conductor and queue the
/// user-authored configuration as a typed Phenix ACP startup request.
///
/// No gateway state, routing table, workflow or backend process is constructed
/// by the frontend. The conductor receives `_phenix/config/apply` after ACP
/// initialization and owns the resulting immutable configuration revision.
pub fn load_acp_backend(
    config_directory: &Path,
    config: &AcpApplicationConfig,
    cwd: &Path,
    _channel_capacity: usize,
) -> Result<AcpAgentBackend, AcpConfigLoadError> {
    let params = configuration_request(config_directory, config);
    let request = encode_extension_request::<ConfigurationApply>(&params)
        .map_err(|error| AcpConfigLoadError::Protocol(error.to_string()))?;
    let conductor =
        env::var(CONDUCTOR_COMMAND_ENV).unwrap_or_else(|_| "phenix-conductor".to_owned());
    let transport = AcpBackendConfig::new(conductor, cwd.to_path_buf())?;
    Ok(AcpAgentBackend::new(transport).with_startup_request(request))
}

fn configuration_request(
    config_directory: &Path,
    config: &AcpApplicationConfig,
) -> ConfigurationApplyParams {
    ConfigurationApplyParams {
        source_root: config_directory.to_path_buf(),
        input: ConfigurationInput {
            definition_id: config.definition_id().clone(),
            router: config.router().clone(),
            backends: config
                .backends()
                .iter()
                .map(|backend| ConfigurationBackendInput {
                    id: backend.id().clone(),
                    command: backend.command().to_owned(),
                    environment: backend.environment().clone(),
                })
                .collect(),
            definitions: config.definitions().iter().map(map_definition).collect(),
            tools: ToolConfiguration::new(),
            standard_session: config.standard_session().map(|session| {
                ConfigurationStandardSessionInput {
                    role: session.role().clone(),
                    difficulty: session.difficulty(),
                    objective: session.objective().to_owned(),
                }
            }),
        },
    }
}

fn map_definition(input: &AcpDefinitionInput) -> ConfigurationDefinitionInput {
    match input {
        AcpDefinitionInput::Workflow(source) => ConfigurationDefinitionInput::Workflow {
            source: map_source(source),
        },
        AcpDefinitionInput::RoutingTable(source) => ConfigurationDefinitionInput::RoutingTable {
            source: map_source(source),
        },
    }
}

fn map_source(source: &AcpDefinitionSource) -> ConfigurationSource {
    match source {
        AcpDefinitionSource::Path(path) => ConfigurationSource::Path { path: path.clone() },
        AcpDefinitionSource::Inline { source, format } => ConfigurationSource::Inline {
            source: source.clone(),
            format: format.map(map_format),
        },
    }
}

fn map_format(format: DefinitionFormat) -> ConfigurationFormat {
    match format {
        DefinitionFormat::Markdown => ConfigurationFormat::Markdown,
        DefinitionFormat::Json => ConfigurationFormat::Json,
        DefinitionFormat::Toml => ConfigurationFormat::Toml,
        DefinitionFormat::Ron => ConfigurationFormat::Ron,
    }
}

#[derive(Debug)]
pub enum AcpConfigLoadError {
    Protocol(String),
    BackendConfig(BackendConfigError),
}

impl From<BackendConfigError> for AcpConfigLoadError {
    fn from(source: BackendConfigError) -> Self {
        Self::BackendConfig(source)
    }
}

impl Display for AcpConfigLoadError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(message) => write!(
                formatter,
                "failed to encode Phenix ACP configuration request: {message}"
            ),
            Self::BackendConfig(source) => Display::fmt(source, formatter),
        }
    }
}

impl Error for AcpConfigLoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::BackendConfig(source) => Some(source),
            Self::Protocol(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn frontend_configuration_uses_the_wire_control_plane_not_a_temp_file() {
        assert!(!include_str!("acp_config.rs").contains(concat!("PHENIX_CONFIGURATION_", "FILE")));
    }
}
