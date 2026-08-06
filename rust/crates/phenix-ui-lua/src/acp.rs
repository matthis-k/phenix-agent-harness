use crate::provider::LuaState;
use mlua::{Lua, Table, Value};
use phenix_acp::{BackendId, DefinitionFormat, DefinitionId, RoleId, RouterId, SessionTreeId};
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
