use crate::protocol::{AcpMethod, AcpNotification};
use crate::{
    BackendId, DefinitionFormat, DefinitionId, Difficulty, RoleId, RouterId, ToolConfiguration,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Source syntax accepted at the application boundary.
///
/// These values are authoring inputs only. They are not the canonical Phenix
/// configuration. Phenix ACP resolves and parses them before constructing an
/// owned configuration revision.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConfigurationSource {
    Path {
        path: PathBuf,
    },
    Inline {
        source: String,
        #[serde(default)]
        format: Option<DefinitionFormat>,
    },
}

impl ConfigurationSource {
    pub fn load(
        &self,
        source_root: &Path,
    ) -> Result<LoadedConfigurationSource, ConfigurationSourceError> {
        match self {
            Self::Path { path } => load_path_source(source_root, path),
            Self::Inline { source, format } => {
                if source.trim().is_empty() {
                    return Err(ConfigurationSourceError::EmptyInlineSource);
                }
                Ok(LoadedConfigurationSource {
                    source: source.clone(),
                    format: *format,
                    origin: ConfigurationSourceOrigin::Inline,
                })
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LoadedConfigurationSource {
    pub source: String,
    pub format: Option<DefinitionFormat>,
    pub origin: ConfigurationSourceOrigin,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigurationSourceOrigin {
    Path(PathBuf),
    Inline,
}

/// User-supplied framework configuration.
///
/// This contains reusable policy and definitions only. It deliberately does not
/// identify a concrete session tree. A tree is an instance created later through
/// `_phenix/session_tree/create` and freezes the active configuration revision.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationInput {
    pub definition_id: DefinitionId,
    pub router: RouterId,
    pub backends: Vec<ConfigurationBackendInput>,
    pub definitions: Vec<ConfigurationDefinitionInput>,
    #[serde(default)]
    pub tools: ToolConfiguration,
    /// Optional projection used only when a standard ACP `session/new` must be
    /// translated into a Phenix tree. Phenix-specific clients should create
    /// trees explicitly instead of relying on this standard ACP projection.
    #[serde(default)]
    pub standard_session: Option<ConfigurationStandardSessionInput>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationStandardSessionInput {
    pub role: RoleId,
    pub difficulty: Difficulty,
    pub objective: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationBackendInput {
    pub id: BackendId,
    pub command: String,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConfigurationDefinitionInput {
    Workflow { source: ConfigurationSource },
    RoutingTable { source: ConfigurationSource },
}

pub struct ConfigurationApply;

impl AcpMethod for ConfigurationApply {
    const METHOD: &'static str = "_phenix/config/apply";
    type Params = ConfigurationApplyParams;
    type Result = ConfigurationApplyResult;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurationApplyParams {
    /// Filesystem root used by Phenix ACP when resolving path sources.
    pub source_root: PathBuf,
    /// Application-provided source descriptors. Phenix ACP constructs the actual
    /// immutable configuration revision from this input.
    pub input: ConfigurationInput,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConfigurationApplyResult {
    pub revision: u64,
    pub definition_id: DefinitionId,
    pub router: RouterId,
}

pub struct ConfigurationGet;

impl AcpMethod for ConfigurationGet {
    const METHOD: &'static str = "_phenix/config/get";
    type Params = ConfigurationGetParams;
    type Result = ConfigurationGetResult;
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConfigurationGetParams {}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConfigurationGetResult {
    pub active: Option<ConfigurationSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConfigurationSnapshot {
    pub revision: u64,
    pub definition_id: DefinitionId,
    pub router: RouterId,
    pub backend_ids: Vec<BackendId>,
    pub workflow_count: usize,
    pub routing_table_count: usize,
    pub has_standard_session_template: bool,
    pub mcp_server_count: usize,
}

pub struct ConfigurationChangedNotification;

impl AcpNotification for ConfigurationChangedNotification {
    const METHOD: &'static str = "_phenix/config/changed";
    type Params = ConfigurationChangedParams;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ConfigurationChangedParams {
    pub configuration: ConfigurationSnapshot,
}

#[derive(Debug)]
pub enum ConfigurationSourceError {
    EmptyPath,
    AbsolutePath(PathBuf),
    EscapingPath(PathBuf),
    ResolveRoot { path: PathBuf, source: io::Error },
    ResolveSource { path: PathBuf, source: io::Error },
    OutsideSourceRoot { root: PathBuf, path: PathBuf },
    UnknownFormat(PathBuf),
    Read { path: PathBuf, source: io::Error },
    EmptyInlineSource,
}

impl Display for ConfigurationSourceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPath => formatter.write_str("configuration source path must not be empty"),
            Self::AbsolutePath(path) => write!(
                formatter,
                "configuration source path must be relative to the ACP-owned source root: {}",
                path.display()
            ),
            Self::EscapingPath(path) => write!(
                formatter,
                "configuration source path must not escape its ACP-owned source root: {}",
                path.display()
            ),
            Self::ResolveRoot { path, source } => write!(
                formatter,
                "failed to resolve configuration source root {}: {source}",
                path.display()
            ),
            Self::ResolveSource { path, source } => write!(
                formatter,
                "failed to resolve configuration source {}: {source}",
                path.display()
            ),
            Self::OutsideSourceRoot { root, path } => write!(
                formatter,
                "resolved configuration source {} is outside source root {}",
                path.display(),
                root.display()
            ),
            Self::UnknownFormat(path) => write!(
                formatter,
                "cannot infer configuration source format from {}",
                path.display()
            ),
            Self::Read { path, source } => write!(
                formatter,
                "failed to read configuration source {}: {source}",
                path.display()
            ),
            Self::EmptyInlineSource => {
                formatter.write_str("inline configuration source must not be empty")
            }
        }
    }
}

impl Error for ConfigurationSourceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::ResolveRoot { source, .. }
            | Self::ResolveSource { source, .. }
            | Self::Read { source, .. } => Some(source),
            Self::EmptyPath
            | Self::AbsolutePath(_)
            | Self::EscapingPath(_)
            | Self::OutsideSourceRoot { .. }
            | Self::UnknownFormat(_)
            | Self::EmptyInlineSource => None,
        }
    }
}

fn load_path_source(
    source_root: &Path,
    relative_path: &Path,
) -> Result<LoadedConfigurationSource, ConfigurationSourceError> {
    validate_relative_path(relative_path)?;
    let root =
        fs::canonicalize(source_root).map_err(|source| ConfigurationSourceError::ResolveRoot {
            path: source_root.to_path_buf(),
            source,
        })?;
    let joined = root.join(relative_path);
    let path =
        fs::canonicalize(&joined).map_err(|source| ConfigurationSourceError::ResolveSource {
            path: joined.clone(),
            source,
        })?;
    if !path.starts_with(&root) {
        return Err(ConfigurationSourceError::OutsideSourceRoot { root, path });
    }
    let format = path
        .extension()
        .and_then(|extension| extension.to_str())
        .and_then(DefinitionFormat::from_extension)
        .ok_or_else(|| ConfigurationSourceError::UnknownFormat(path.clone()))?;
    let source = fs::read_to_string(&path).map_err(|source| ConfigurationSourceError::Read {
        path: path.clone(),
        source,
    })?;
    if source.trim().is_empty() {
        return Err(ConfigurationSourceError::EmptyInlineSource);
    }
    Ok(LoadedConfigurationSource {
        source,
        format: Some(format),
        origin: ConfigurationSourceOrigin::Path(path),
    })
}

fn validate_relative_path(path: &Path) -> Result<(), ConfigurationSourceError> {
    if path.as_os_str().is_empty() {
        return Err(ConfigurationSourceError::EmptyPath);
    }
    if path.is_absolute() {
        return Err(ConfigurationSourceError::AbsolutePath(path.to_path_buf()));
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(ConfigurationSourceError::EscapingPath(path.to_path_buf()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_sources_are_descriptors_not_preloaded_content() {
        let source = ConfigurationSource::Path {
            path: PathBuf::from("workflows/implement.md"),
        };
        let encoded = serde_json::to_value(source).expect("configuration source JSON");
        assert_eq!(encoded["kind"], "path");
        assert_eq!(encoded["path"], "workflows/implement.md");
        assert!(encoded.get("source").is_none());
    }

    #[test]
    fn path_sources_cannot_escape_the_acp_owned_root() {
        assert!(matches!(
            validate_relative_path(Path::new("../outside.md")),
            Err(ConfigurationSourceError::EscapingPath(_))
        ));
        assert!(matches!(
            validate_relative_path(Path::new("/absolute.md")),
            Err(ConfigurationSourceError::AbsolutePath(_))
        ));
    }

    #[test]
    fn inline_sources_remain_explicit_strings() {
        let source = ConfigurationSource::Inline {
            source: "# Workflow".to_owned(),
            format: Some(DefinitionFormat::Markdown),
        };
        let loaded = source
            .load(Path::new("unused"))
            .expect("inline source does not touch the filesystem");
        assert_eq!(loaded.source, "# Workflow");
        assert_eq!(loaded.format, Some(DefinitionFormat::Markdown));
        assert_eq!(loaded.origin, ConfigurationSourceOrigin::Inline);
    }
}
