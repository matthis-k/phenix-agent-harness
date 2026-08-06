from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]


def replace(path: str, old: str, new: str) -> None:
    target = ROOT / path
    source = target.read_text()
    if old not in source:
        raise RuntimeError(f"expected snippet not found in {path}: {old[:80]!r}")
    target.write_text(source.replace(old, new, 1))


# phenix-ui-lua owns the frontend application's Lua declarations.
replace(
    "rust/crates/phenix-ui-lua/Cargo.toml",
    'mlua = { workspace = true }\n',
    'mlua = { workspace = true }\nphenix-acp = { path = "../phenix-acp" }\n',
)
replace(
    "rust/crates/phenix-ui-lua/src/lib.rs",
    "mod api;\n",
    "mod acp;\nmod api;\n",
)
replace(
    "rust/crates/phenix-ui-lua/src/lib.rs",
    "pub use key::{KeyChord, KeyParseError};\n",
    "pub use acp::{\n    AcpApplicationConfig, AcpBackendConfig, AcpDefinitionInput, AcpDefinitionSource,\n    AcpRootConfig,\n};\npub use key::{KeyChord, KeyParseError};\n",
)

(ROOT / "rust/crates/phenix-ui-lua/src/acp.rs").write_text(r'''use crate::provider::LuaState;
use mlua::{Lua, Table, Value};
use phenix_acp::{
    BackendId, DefinitionFormat, DefinitionId, RoleId, RouterId, SessionTreeId,
};
use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpApplicationConfig {
    definition_id: DefinitionId,
    router: RouterId,
    backend: AcpBackendConfig,
    root: AcpRootConfig,
    definitions: Vec<AcpDefinitionInput>,
}

impl AcpApplicationConfig {
    pub fn definition_id(&self) -> &DefinitionId {
        &self.definition_id
    }

    pub fn router(&self) -> &RouterId {
        &self.router
    }

    pub fn backend(&self) -> &AcpBackendConfig {
        &self.backend
    }

    pub fn root(&self) -> &AcpRootConfig {
        &self.root
    }

    pub fn definitions(&self) -> &[AcpDefinitionInput] {
        &self.definitions
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpBackendConfig {
    id: BackendId,
    command: String,
}

impl AcpBackendConfig {
    pub fn id(&self) -> &BackendId {
        &self.id
    }

    pub fn command(&self) -> &str {
        &self.command
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpRootConfig {
    tree_id: SessionTreeId,
    role: RoleId,
    objective: String,
}

impl AcpRootConfig {
    pub fn tree_id(&self) -> &SessionTreeId {
        &self.tree_id
    }

    pub fn role(&self) -> &RoleId {
        &self.role
    }

    pub fn objective(&self) -> &str {
        &self.objective
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcpDefinitionInput {
    Workflow(AcpDefinitionSource),
    RoutingTable(AcpDefinitionSource),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcpDefinitionSource {
    Path(PathBuf),
    Inline {
        source: String,
        format: Option<DefinitionFormat>,
    },
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AcpConfigurationState {
    base: Option<AcpConfigurationBase>,
    definitions: Vec<AcpDefinitionInput>,
}

#[derive(Clone, Debug)]
struct AcpConfigurationBase {
    definition_id: DefinitionId,
    router: RouterId,
    backend: AcpBackendConfig,
    root: AcpRootConfig,
}

impl AcpConfigurationState {
    pub fn configuration(&self) -> Option<AcpApplicationConfig> {
        self.base.as_ref().map(|base| AcpApplicationConfig {
            definition_id: base.definition_id.clone(),
            router: base.router.clone(),
            backend: base.backend.clone(),
            root: base.root.clone(),
            definitions: self.definitions.clone(),
        })
    }
}

pub(crate) fn install_acp_api(
    lua: &Lua,
    state: Rc<RefCell<LuaState>>,
) -> Result<(), phenix_frontend_config::FrontendProviderError> {
    let api = lua.create_table().map_err(runtime_error)?;

    let configure_state = Rc::clone(&state);
    api.set(
        "configure",
        lua.create_function(move |_, table: Table| {
            deny_unknown_fields(
                &table,
                &["definition_id", "router", "backend", "root"],
                "phenix.acp.configure",
            )?;
            let backend: Table = table.get("backend")?;
            deny_unknown_fields(&backend, &["id", "command"], "backend")?;
            let root: Table = table.get("root")?;
            deny_unknown_fields(&root, &["tree_id", "role", "objective"], "root")?;

            let command: String = backend.get("command")?;
            if command.trim().is_empty() {
                return Err(configuration_error("backend.command must not be empty"));
            }
            let objective: String = root.get("objective")?;
            if objective.trim().is_empty() {
                return Err(configuration_error("root.objective must not be empty"));
            }

            let base = AcpConfigurationBase {
                definition_id: DefinitionId::parse(table.get::<String>("definition_id")?)
                    .map_err(mlua::Error::external)?,
                router: RouterId::parse(table.get::<String>("router")?)
                    .map_err(mlua::Error::external)?,
                backend: AcpBackendConfig {
                    id: BackendId::parse(backend.get::<String>("id")?)
                        .map_err(mlua::Error::external)?,
                    command,
                },
                root: AcpRootConfig {
                    tree_id: SessionTreeId::parse(root.get::<String>("tree_id")?)
                        .map_err(mlua::Error::external)?,
                    role: RoleId::parse(root.get::<String>("role")?)
                        .map_err(mlua::Error::external)?,
                    objective,
                },
            };

            let mut state = configure_state.borrow_mut();
            if state.acp.base.replace(base).is_some() {
                return Err(configuration_error(
                    "phenix.acp.configure may only be called once",
                ));
            }
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    api.set(
        "workflow",
        definition_function(lua, Rc::clone(&state), DefinitionInputKind::Workflow)?,
    )
    .map_err(runtime_error)?;
    api.set(
        "routing_table",
        definition_function(lua, state, DefinitionInputKind::RoutingTable)?,
    )
    .map_err(runtime_error)?;

    let phenix: Table = lua.globals().get("phenix").map_err(runtime_error)?;
    phenix.set("acp", api).map_err(runtime_error)
}

#[derive(Clone, Copy)]
enum DefinitionInputKind {
    Workflow,
    RoutingTable,
}

fn definition_function(
    lua: &Lua,
    state: Rc<RefCell<LuaState>>,
    kind: DefinitionInputKind,
) -> Result<mlua::Function, phenix_frontend_config::FrontendProviderError> {
    lua.create_function(move |_, value: Value| {
        let source = parse_definition_source(value)?;
        let input = match kind {
            DefinitionInputKind::Workflow => AcpDefinitionInput::Workflow(source),
            DefinitionInputKind::RoutingTable => AcpDefinitionInput::RoutingTable(source),
        };
        state.borrow_mut().acp.definitions.push(input);
        Ok(())
    })
    .map_err(runtime_error)
}

fn parse_definition_source(value: Value) -> mlua::Result<AcpDefinitionSource> {
    match value {
        Value::String(path) => {
            let path = path.to_str()?.trim().to_owned();
            if path.is_empty() {
                return Err(configuration_error("definition path must not be empty"));
            }
            Ok(AcpDefinitionSource::Path(PathBuf::from(path)))
        }
        Value::Table(table) => {
            deny_unknown_fields(&table, &["path", "source", "format"], "definition")?;
            let path = table.get::<Option<String>>("path")?;
            let source = table.get::<Option<String>>("source")?;
            match (path, source) {
                (Some(path), None) => {
                    if table.get::<Option<String>>("format")?.is_some() {
                        return Err(configuration_error(
                            "path definitions infer their format from the extension",
                        ));
                    }
                    if path.trim().is_empty() {
                        return Err(configuration_error("definition path must not be empty"));
                    }
                    Ok(AcpDefinitionSource::Path(PathBuf::from(path)))
                }
                (None, Some(source)) => {
                    if source.trim().is_empty() {
                        return Err(configuration_error("definition source must not be empty"));
                    }
                    let format = table
                        .get::<Option<String>>("format")?
                        .map(|format| parse_format(&format))
                        .transpose()?;
                    Ok(AcpDefinitionSource::Inline { source, format })
                }
                (Some(_), Some(_)) => Err(configuration_error(
                    "definition input must contain either path or source, not both",
                )),
                (None, None) => Err(configuration_error(
                    "definition input must contain path or source",
                )),
            }
        }
        _ => Err(configuration_error(
            "definition input must be a relative path string or a table",
        )),
    }
}

fn parse_format(value: &str) -> mlua::Result<DefinitionFormat> {
    match value.trim().to_ascii_lowercase().as_str() {
        "md" | "markdown" => Ok(DefinitionFormat::Markdown),
        "json" => Ok(DefinitionFormat::Json),
        "toml" => Ok(DefinitionFormat::Toml),
        "ron" => Ok(DefinitionFormat::Ron),
        _ => Err(configuration_error(format!(
            "unsupported definition format {value:?}; expected markdown, json, toml, or ron"
        ))),
    }
}

fn deny_unknown_fields(table: &Table, allowed: &[&str], context: &str) -> mlua::Result<()> {
    for pair in table.clone().pairs::<Value, Value>() {
        let (key, _) = pair?;
        let Value::String(key) = key else {
            return Err(configuration_error(format!(
                "{context} keys must be strings"
            )));
        };
        let key = key.to_str()?;
        if !allowed.contains(&key.as_ref()) {
            return Err(configuration_error(format!(
                "unknown {context} field {key}"
            )));
        }
    }
    Ok(())
}

fn configuration_error(message: impl Into<String>) -> mlua::Error {
    mlua::Error::RuntimeError(message.into())
}

fn runtime_error(error: mlua::Error) -> phenix_frontend_config::FrontendProviderError {
    phenix_frontend_config::FrontendProviderError::runtime(error.to_string())
}
''')

replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "use crate::api::install_api;\n",
    "use crate::acp::{install_acp_api, AcpApplicationConfig, AcpConfigurationState};\nuse crate::api::install_api;\n",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "    options: LuaFrontendOptions,\n}",
    "    options: LuaFrontendOptions,\n    acp_config: Option<AcpApplicationConfig>,\n}",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "            config: built.config,\n            options,\n",
    "            config: built.config,\n            options,\n            acp_config: built.acp_config,\n",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "    pub fn default_source() -> &'static str {\n        DEFAULT_CONFIG\n    }\n",
    "    pub fn default_source() -> &'static str {\n        DEFAULT_CONFIG\n    }\n\n    pub fn acp_config(&self) -> Option<&AcpApplicationConfig> {\n        self.acp_config.as_ref()\n    }\n",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "        self.config = built.config;\n        Ok(())\n",
    "        self.config = built.config;\n        self.acp_config = built.acp_config;\n        Ok(())\n",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "pub(crate) struct LuaState {\n    pub config: FrontendConfig,\n    pub bindings: Vec<LuaBinding>,\n}",
    "pub(crate) struct LuaState {\n    pub config: FrontendConfig,\n    pub bindings: Vec<LuaBinding>,\n    pub acp: AcpConfigurationState,\n}",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "    config: FrontendConfig,\n}\n\nfn build_provider",
    "    config: FrontendConfig,\n    acp_config: Option<AcpApplicationConfig>,\n}\n\nfn build_provider",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "    install_api(&lua, Rc::clone(&state), Rc::clone(&commands))?;\n",
    "    install_api(&lua, Rc::clone(&state), Rc::clone(&commands))?;\n    install_acp_api(&lua, Rc::clone(&state))?;\n",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "    let config = {\n        let mut state = state.borrow_mut();\n        state.refresh_keymap_descriptions();\n        state.config.clone()\n    };\n    Ok(BuiltProvider {\n        lua,\n        state,\n        commands,\n        config,\n    })",
    "    let (config, acp_config) = {\n        let mut state = state.borrow_mut();\n        state.refresh_keymap_descriptions();\n        (state.config.clone(), state.acp.configuration())\n    };\n    Ok(BuiltProvider {\n        lua,\n        state,\n        commands,\n        config,\n        acp_config,\n    })",
)
replace(
    "rust/crates/phenix-ui-lua/src/provider.rs",
    "    fn context(pane_type: PaneType) -> FrontendContext {",
    r'''    #[test]
    fn lua_configuration_declares_acp_runtime_and_definition_sources() {
        let path = temporary_config(
            r#"
phenix.acp.configure({
  definition_id = "phenix.harness",
  router = "router.mixed",
  backend = { id = "pi", command = "pi-acp" },
  root = {
    tree_id = "tree-frontend",
    role = "coordinator",
    objective = "Interactive tree",
  },
})
phenix.acp.workflow("workflows/implement.md")
phenix.acp.routing_table({ source = [[
# Router
```phenix-router
id: router.mixed
```
## Routes
| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `*` | `*` | `pi/provider/model` | fallback |
]], format = "markdown" })
"#,
        );
        let provider = LuaFrontendProvider::new(LuaFrontendOptions {
            source_path: Some(path.clone()),
            load_defaults: false,
        })
        .expect("Lua provider");
        let config = provider.acp_config().expect("ACP config");
        assert_eq!(config.definition_id().as_str(), "phenix.harness");
        assert_eq!(config.router().as_str(), "router.mixed");
        assert_eq!(config.backend().id().as_str(), "pi");
        assert_eq!(config.definitions().len(), 2);
        fs::remove_file(path).ok();
    }

    fn context(pane_type: PaneType) -> FrontendContext {''',
)

# The TUI consumes the typed Lua declarations and remains responsible for files.
(ROOT / "rust/crates/phenix-tui/src/acp_config.rs").write_text(r'''use phenix_acp::{
    AcpEndpoint, BackendDefinition, BackendId, DefinitionError, DefinitionFormat,
    DefinitionParseError, Definitions, GatewayError, PhenixAcpGateway, RouterId,
    SessionTreeDefinition,
};
use phenix_acp_backend::{
    AcpAgentBackend, AcpBackendConfig, ConfigError as BackendConfigError, GatewayAgentBackend,
};
use phenix_ui_lua::{
    AcpApplicationConfig, AcpDefinitionInput, AcpDefinitionSource,
};
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
''')

# Consolidate CLI and XDG ownership into the application directory.
main_path = ROOT / "rust/crates/phenix-tui/src/main.rs"
main = main_path.read_text()
main = main.replace(
    "use phenix_ui_lua::{LuaFrontendOptions, LuaFrontendProvider};",
    "use phenix_ui_lua::{AcpApplicationConfig, LuaFrontendOptions, LuaFrontendProvider};",
)
old_args = '''    /// Read frontend configuration from this Lua file instead of XDG_CONFIG_HOME/phenix/init.lua.
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,

    /// Read config.json and referenced Phenix ACP definitions from this directory.
    #[arg(short = 'p', long = "phenix-acp-config", value_name = "DIR")]
    phenix_acp_config: Option<PathBuf>,
'''
new_args = '''    /// Read config.lua and referenced definitions from this Phenix Harness directory.
    #[arg(short = 'p', long = "config-dir", value_name = "DIR")]
    config_dir: Option<PathBuf>,
'''
if old_args not in main:
    raise RuntimeError("main.rs arguments block changed")
main = main.replace(old_args, new_args, 1)
old_main = '''    let provider = load_frontend_provider(&arguments)?;
    let acp_config = resolve_acp_config_directory(arguments.phenix_acp_config.as_deref());
    if arguments.check {
        return run_handshake_check(acp_config.as_deref());
    }
    run_tui(provider, acp_config.as_deref())
}

fn load_frontend_provider(arguments: &Arguments) -> Result<FrontendProviderRef, Box<dyn Error>> {
    let source_path = resolve_config_path(arguments.config.as_deref());
    let provider = LuaFrontendProvider::new(LuaFrontendOptions {
        source_path,
        load_defaults: !arguments.no_default_config,
    })?;
    Ok(Rc::new(RefCell::new(provider)))
}

fn resolve_config_path(explicit_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = explicit_path {
        return Some(path.to_path_buf());
    }
    if let Some(path) = env::var_os("PHENIX_CONFIG").map(PathBuf::from) {
        return Some(path);
    }
    default_config_path().filter(|path| path.is_file())
}

fn default_config_path() -> Option<PathBuf> {
    if let Some(root) = env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(root).join("phenix/init.lua"));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config/phenix/init.lua"))
}

fn resolve_acp_config_directory(explicit_path: Option<&Path>) -> Option<PathBuf> {
    explicit_path
        .map(Path::to_path_buf)
        .or_else(|| default_acp_config_directory().filter(|path| path.join("config.json").is_file()))
}

fn default_acp_config_directory() -> Option<PathBuf> {
    if let Some(root) = env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(root).join("phenix-acp"));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config/phenix-acp"))
}
'''
new_main = '''    let config_directory = resolve_config_directory(arguments.config_dir.as_deref())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "cannot resolve the Phenix Harness configuration directory; set XDG_CONFIG_HOME or HOME, or pass -p/--config-dir"))?;
    let (provider, acp_config) = load_frontend_provider(&arguments, &config_directory)?;
    if arguments.check {
        return run_handshake_check(&config_directory, acp_config.as_ref());
    }
    run_tui(provider, &config_directory, acp_config.as_ref())
}

fn load_frontend_provider(
    arguments: &Arguments,
    config_directory: &Path,
) -> Result<(FrontendProviderRef, Option<AcpApplicationConfig>), Box<dyn Error>> {
    let provider = LuaFrontendProvider::new(LuaFrontendOptions {
        source_path: Some(config_directory.join("config.lua")),
        load_defaults: !arguments.no_default_config,
    })?;
    let acp_config = provider.acp_config().cloned();
    Ok((Rc::new(RefCell::new(provider)), acp_config))
}

fn resolve_config_directory(explicit_path: Option<&Path>) -> Option<PathBuf> {
    explicit_path
        .map(Path::to_path_buf)
        .or_else(default_config_directory)
}

fn default_config_directory() -> Option<PathBuf> {
    if let Some(root) = env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(root).join("phenix-harness"));
    }
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".config/phenix-harness"))
}
'''
if old_main not in main:
    raise RuntimeError("main.rs load/config block changed")
main = main.replace(old_main, new_main, 1)
main = main.replace(
    '''fn run_tui(
    provider: FrontendProviderRef,
    acp_config: Option<&Path>,
) -> Result<(), Box<dyn Error>> {
    let backend = spawn_backend(acp_config)?;''',
    '''fn run_tui(
    provider: FrontendProviderRef,
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<(), Box<dyn Error>> {
    let backend = spawn_backend(config_directory, acp_config)?;''',
    1,
)
main = main.replace(
    '''fn run_handshake_check(acp_config: Option<&Path>) -> Result<(), Box<dyn Error>> {
    let backend = spawn_backend(acp_config)?;''',
    '''fn run_handshake_check(
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<(), Box<dyn Error>> {
    let backend = spawn_backend(config_directory, acp_config)?;''',
    1,
)
main = main.replace(
    '''fn spawn_backend(acp_config: Option<&Path>) -> Result<BackendRuntime, Box<dyn Error>> {
    let backend: Box<dyn AgentBackend> =
        match parse_backend_kind(env::var("PHENIX_BACKEND").ok().as_deref())? {
            BackendKind::Process => Box::new(create_process_backend()?),
            BackendKind::Acp => Box::new(create_acp_backend(acp_config)?),
        };''',
    '''fn spawn_backend(
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<BackendRuntime, Box<dyn Error>> {
    let backend: Box<dyn AgentBackend> =
        match parse_backend_kind(env::var("PHENIX_BACKEND").ok().as_deref())? {
            BackendKind::Process => Box::new(create_process_backend()?),
            BackendKind::Acp => Box::new(create_acp_backend(config_directory, acp_config)?),
        };''',
    1,
)
old_create = '''fn create_acp_backend(config_directory: Option<&Path>) -> Result<GatewayAgentBackend, Box<dyn Error>> {
    let config_directory = config_directory.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "Phenix ACP configuration was not found; create XDG_CONFIG_HOME/phenix-acp/config.json or pass -p/--phenix-acp-config",
        )
    })?;
    Ok(load_acp_backend(
        config_directory,
        &env::current_dir()?,
        CHANNEL_CAPACITY,
    )?)
}
'''
new_create = '''fn create_acp_backend(
    config_directory: &Path,
    acp_config: Option<&AcpApplicationConfig>,
) -> Result<GatewayAgentBackend, Box<dyn Error>> {
    let acp_config = acp_config.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} must call phenix.acp.configure(...) and register workflow/routing definitions",
                config_directory.join("config.lua").display()
            ),
        )
    })?;
    Ok(load_acp_backend(
        config_directory,
        acp_config,
        &env::current_dir()?,
        CHANNEL_CAPACITY,
    )?)
}
'''
if old_create not in main:
    raise RuntimeError("main.rs ACP backend block changed")
main = main.replace(old_create, new_create, 1)
main = main.replace(
    '''    #[test]
    fn xdg_config_path_uses_a_neovim_style_init_lua() {
        let path = PathBuf::from("/tmp/xdg-config").join("phenix/init.lua");
        assert_eq!(path, PathBuf::from("/tmp/xdg-config/phenix/init.lua"));
    }

    #[test]
    fn xdg_acp_config_uses_a_dedicated_directory() {
        let path = PathBuf::from("/tmp/xdg-config").join("phenix-acp");
        assert_eq!(path, PathBuf::from("/tmp/xdg-config/phenix-acp"));
    }
''',
    '''    #[test]
    fn xdg_config_uses_the_phenix_harness_application_directory() {
        let path = PathBuf::from("/tmp/xdg-config").join("phenix-harness");
        assert_eq!(path, PathBuf::from("/tmp/xdg-config/phenix-harness"));
        assert_eq!(path.join("config.lua"), PathBuf::from("/tmp/xdg-config/phenix-harness/config.lua"));
    }
''',
    1,
)
main_path.write_text(main)

# The actual frontend configuration uses the converted legacy definitions.
old_config = ROOT / "config/phenix-acp"
new_config = ROOT / "config/phenix-harness"
if new_config.exists():
    shutil.rmtree(new_config)
new_config.mkdir(parents=True)
shutil.copytree(
    ROOT / "rust/crates/phenix-acp/tests/fixtures/legacy/workflows",
    new_config / "workflows",
)
shutil.copytree(
    ROOT / "rust/crates/phenix-acp/tests/fixtures/legacy/routing",
    new_config / "routing",
)
if old_config.exists():
    shutil.rmtree(old_config)

(new_config / "config.lua").write_text(r'''phenix.acp.configure({
  definition_id = "phenix.harness",
  router = "router.legacy-mixed",
  backend = {
    id = "pi",
    command = "pi-acp",
  },
  root = {
    tree_id = "tree-frontend",
    role = "coordinator",
    objective = "Interactive Phenix session tree",
  },
})

phenix.acp.workflow("workflows/debug.md")
phenix.acp.workflow("workflows/design.md")
phenix.acp.workflow("workflows/implement.md")
phenix.acp.workflow("workflows/migrate.md")
phenix.acp.workflow("workflows/qa.md")
phenix.acp.workflow("workflows/refactor.md")
phenix.acp.workflow("workflows/research.md")
phenix.acp.workflow("workflows/review.md")
phenix.acp.workflow("workflows/security.md")
phenix.acp.workflow("workflows/ui-change.md")

phenix.acp.routing_table("routing/free.md")
phenix.acp.routing_table("routing/opencode-go.md")
phenix.acp.routing_table("routing/chatgpt-plus.md")
phenix.acp.routing_table("routing/mixed.md")
''')
(new_config / "README.md").write_text(r'''# Phenix Harness frontend configuration

This directory is an example user configuration for the native Phenix frontend. Install or link it at:

```text
$XDG_CONFIG_HOME/phenix-harness/
```

The frontend reads `config.lua`. Lua configures both UI behavior and the ACP session-tree runtime. Referenced workflow and routing files are resolved relative to this directory and passed as source text to `phenix-acp`.

The included definitions are static session-tree projections of the former Pi workflows and the default-difficulty, first-candidate projections of its four model sets. They preserve the legacy IDs and delegated roles, while state-machine-only features such as joins, retries, decisions, difficulty branches, and nested workflow invocation remain outside the current static format.
''')

# Rewrite the Nix frontend module around one application config directory.
(ROOT / "modules/phenix-frontend.nix").write_text(r'''_:

{
  perSystem =
    { config, pkgs, ... }:
    let
      rustSource = pkgs.lib.cleanSource ../rust;

      phenixTui = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-tui";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-tui"
        ];
        cargoTestFlags = [
          "--package"
          "phenix-tui"
        ];

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          phenix_binary="$(find target -path '*/release/phenix' -type f -print -quit)"
          test -n "$phenix_binary"
          cp "$phenix_binary" "$out/bin/phenix"
          runHook postInstall
        '';
      };

      phenixAcpSmoke = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-acp-smoke";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-acp-presets"
          "--bin"
          "phenix-acp-smoke"
        ];
        cargoTestFlags = [
          "--package"
          "phenix-acp-presets"
        ];

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          smoke_binary="$(find target -path '*/release/phenix-acp-smoke' -type f -print -quit)"
          test -n "$smoke_binary"
          cp "$smoke_binary" "$out/bin/phenix-acp-smoke"
          runHook postInstall
        '';
      };

      mkPhenixWrapper =
        {
          name ? "phenix",
          configDir ? null,
          loadDefaults ? true,
          extraArgs ? [ ],
        }:
        let
          wrapperArguments =
            (pkgs.lib.optionals (configDir != null) [
              "--config-dir"
              (toString configDir)
            ])
            ++ (pkgs.lib.optional (!loadDefaults) "--no-default-config")
            ++ extraArgs;
        in
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [
            pkgs.nodejs
            config.packages.pi-acp
          ];
          text = ''
            export PHENIX_HEADLESS_PROGRAM="${pkgs.nodejs}/bin/node"
            export PHENIX_HEADLESS_ENTRY="${config.packages.phenix-pi-package}/headless/main.ts"
            export PHENIX_SOURCE_ROOT="${config.packages.phenix-pi-package}"
            exec "${phenixTui}/bin/phenix" ${pkgs.lib.escapeShellArgs wrapperArguments} "$@"
          '';
        };

      phenix = mkPhenixWrapper { };

      configuredSmokeDir = pkgs.runCommand "phenix-configured-smoke-config" { } ''
        cp -R ${../config/phenix-harness} "$out"
        cat >> "$out/config.lua" <<'EOF_CONFIG'
        phenix.keymap.del("global", "<C-q>")
        phenix.theme.set("Accent", { fg = "#ffffff", bold = true })
        assert(type(phenix.ui.pane.resize) == "function")
        EOF_CONFIG
      '';

      configuredSmokePackage = mkPhenixWrapper {
        name = "phenix-configured-smoke";
        configDir = configuredSmokeDir;
      };

      phenixSmoke =
        pkgs.runCommand "phenix-frontend-smoke"
          {
            nativeBuildInputs = [
              phenix
              phenixAcpSmoke
              configuredSmokePackage
            ];
          }
          ''
            export HOME="$TMPDIR/home"
            export XDG_CONFIG_HOME="$HOME/.config"
            export XDG_DATA_HOME="$HOME/.local/share"
            export XDG_STATE_HOME="$HOME/.local/state"
            export XDG_CACHE_HOME="$HOME/.cache"
            export PI_SKIP_VERSION_CHECK=1
            mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
            cp -R ${../config/phenix-harness} "$XDG_CONFIG_HOME/phenix-harness"

            phenix --print-default-config | grep -q 'phenix.layout.set'
            phenix --check
            phenix-configured-smoke --check
            phenix-acp-smoke
            touch "$out"
          '';
    in
    {
      packages = {
        phenix-tui = phenixTui;
        phenix-acp-smoke = phenixAcpSmoke;
        inherit phenix;
        default = pkgs.lib.mkForce phenix;
      };

      legacyPackages.phenixFrontend = {
        inherit mkPhenixWrapper;
        defaultLua = ../rust/crates/phenix-ui-lua/default.lua;
        exampleConfig = ../config/phenix-harness;
      };

      apps.phenix.program = pkgs.lib.getExe phenix;
      apps.default.program = pkgs.lib.getExe phenix;

      checks.phenix-frontend = phenixSmoke;
    };
}
''')
