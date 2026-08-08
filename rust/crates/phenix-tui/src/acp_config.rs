use phenix_acp::{
    ConfigurationApplyParams, ConfigurationBackendInput, ConfigurationDefinitionInput,
    ConfigurationFormat, ConfigurationInput, ConfigurationRootInput, ConfigurationSource,
    DefinitionFormat,
};
use phenix_acp_backend::{AcpAgentBackend, AcpBackendConfig, ConfigError as BackendConfigError};
use phenix_ui_lua::{AcpApplicationConfig, AcpDefinitionInput, AcpDefinitionSource};
use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CONFIGURATION_FILE_ENV: &str = "PHENIX_CONFIGURATION_FILE";
const CONDUCTOR_COMMAND_ENV: &str = "PHENIX_CONDUCTOR_COMMAND";

/// Build a direct ACP client backend for the Phenix conductor.
///
/// The frontend serializes only source descriptors. It does not resolve or parse
/// definition files and it never constructs the conductor-owned gateway runtime.
/// The conductor reads this typed request and creates the canonical configuration
/// object inside the ACP process.
pub fn load_acp_backend(
    config_directory: &Path,
    config: &AcpApplicationConfig,
    cwd: &Path,
    _channel_capacity: usize,
) -> Result<AcpAgentBackend, AcpConfigLoadError> {
    let request = configuration_request(config_directory, config);
    let request_path = write_configuration_request(&request)?;
    let conductor =
        env::var(CONDUCTOR_COMMAND_ENV).unwrap_or_else(|_| "phenix-conductor".to_owned());
    let command = format!(
        "env {CONFIGURATION_FILE_ENV}={} {conductor}",
        shell_quote(&request_path.display().to_string())
    );
    let transport = AcpBackendConfig::new(command, cwd.to_path_buf())?;
    Ok(AcpAgentBackend::new(transport))
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
            root: ConfigurationRootInput {
                tree_id: config.root().tree_id().clone(),
                role: config.root().role().clone(),
                objective: config.root().objective().to_owned(),
            },
            backends: vec![ConfigurationBackendInput {
                id: config.backend().id().clone(),
                command: config.backend().command().to_owned(),
                environment: BTreeMap::new(),
            }],
            definitions: config.definitions().iter().map(map_definition).collect(),
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

fn write_configuration_request(
    request: &ConfigurationApplyParams,
) -> Result<PathBuf, AcpConfigLoadError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AcpConfigLoadError::Clock(error.to_string()))?
        .as_nanos();
    let path = env::temp_dir().join(format!(
        "phenix-configuration-{}-{nonce}.json",
        std::process::id()
    ));
    let bytes = serde_json::to_vec(request).map_err(AcpConfigLoadError::Encode)?;
    write_private_file(&path, &bytes)?;
    Ok(path)
}

#[cfg(unix)]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), AcpConfigLoadError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|source| AcpConfigLoadError::Write {
            path: path.to_path_buf(),
            source,
        })?;
    file.write_all(bytes)
        .map_err(|source| AcpConfigLoadError::Write {
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(not(unix))]
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), AcpConfigLoadError> {
    fs::write(path, bytes).map_err(|source| AcpConfigLoadError::Write {
        path: path.to_path_buf(),
        source,
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[derive(Debug)]
pub enum AcpConfigLoadError {
    Encode(serde_json::Error),
    Write { path: PathBuf, source: io::Error },
    Clock(String),
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
            Self::Encode(source) => {
                write!(
                    formatter,
                    "failed to encode Phenix ACP configuration input: {source}"
                )
            }
            Self::Write { path, source } => write!(
                formatter,
                "failed to write private Phenix ACP configuration input {}: {source}",
                path.display()
            ),
            Self::Clock(message) => write!(
                formatter,
                "failed to create a unique Phenix ACP configuration input path: {message}"
            ),
            Self::BackendConfig(source) => Display::fmt(source, formatter),
        }
    }
}

impl Error for AcpConfigLoadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Encode(source) => Some(source),
            Self::Write { source, .. } => Some(source),
            Self::BackendConfig(source) => Some(source),
            Self::Clock(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quoting_preserves_paths_as_one_argument() {
        assert_eq!(shell_quote("/tmp/a b's.json"), "'/tmp/a b'\\''s.json'");
    }
}
