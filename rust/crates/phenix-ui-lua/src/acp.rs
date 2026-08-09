use crate::provider::LuaState;
use mlua::{Lua, Table, Value};
use phenix_acp::{BackendId, DefinitionFormat, DefinitionId, Difficulty, RoleId, RouterId};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::rc::Rc;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpApplicationConfig {
    definition_id: DefinitionId,
    router: RouterId,
    backends: Vec<AcpBackendConfig>,
    standard_session: Option<AcpStandardSessionConfig>,
    definitions: Vec<AcpDefinitionInput>,
}

impl AcpApplicationConfig {
    pub fn definition_id(&self) -> &DefinitionId {
        &self.definition_id
    }

    pub fn router(&self) -> &RouterId {
        &self.router
    }

    pub fn backends(&self) -> &[AcpBackendConfig] {
        &self.backends
    }

    pub fn standard_session(&self) -> Option<&AcpStandardSessionConfig> {
        self.standard_session.as_ref()
    }

    pub fn definitions(&self) -> &[AcpDefinitionInput] {
        &self.definitions
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpBackendConfig {
    id: BackendId,
    command: String,
    environment: BTreeMap<String, String>,
}

impl AcpBackendConfig {
    pub fn id(&self) -> &BackendId {
        &self.id
    }

    pub fn command(&self) -> &str {
        &self.command
    }

    pub fn environment(&self) -> &BTreeMap<String, String> {
        &self.environment
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcpStandardSessionConfig {
    role: RoleId,
    difficulty: Difficulty,
    objective: String,
}

impl AcpStandardSessionConfig {
    pub fn role(&self) -> &RoleId {
        &self.role
    }

    pub fn difficulty(&self) -> Difficulty {
        self.difficulty
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
    backends: Vec<AcpBackendConfig>,
    definitions: Vec<AcpDefinitionInput>,
}

#[derive(Clone, Debug)]
struct AcpConfigurationBase {
    definition_id: DefinitionId,
    router: RouterId,
    standard_session: Option<AcpStandardSessionConfig>,
}

impl AcpConfigurationState {
    pub fn configuration(&self) -> Option<AcpApplicationConfig> {
        self.base.as_ref().map(|base| AcpApplicationConfig {
            definition_id: base.definition_id.clone(),
            router: base.router.clone(),
            backends: self.backends.clone(),
            standard_session: base.standard_session.clone(),
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
                &["definition_id", "router", "standard_session"],
                "phenix.acp.configure",
            )?;
            let standard_session = table
                .get::<Option<Table>>("standard_session")?
                .map(parse_standard_session)
                .transpose()?;
            let base = AcpConfigurationBase {
                definition_id: DefinitionId::parse(table.get::<String>("definition_id")?)
                    .map_err(mlua::Error::external)?,
                router: RouterId::parse(table.get::<String>("router")?)
                    .map_err(mlua::Error::external)?,
                standard_session,
            };

            let mut state = configure_state.borrow_mut();
            if state.acp.base.replace(base).is_some() {
                return Err(configuration_error(
                    "phenix.acp.configure may only be called once per authoring evaluation",
                ));
            }
            Ok(())
        })
        .map_err(runtime_error)?,
    )
    .map_err(runtime_error)?;

    let backend_state = Rc::clone(&state);
    api.set(
        "backend",
        lua.create_function(move |_, table: Table| {
            deny_unknown_fields(&table, &["id", "command", "environment"], "backend")?;
            let command: String = table.get("command")?;
            if command.trim().is_empty() {
                return Err(configuration_error("backend.command must not be empty"));
            }
            let environment = table
                .get::<Option<Table>>("environment")?
                .map(parse_environment)
                .transpose()?
                .unwrap_or_default();
            let backend = AcpBackendConfig {
                id: BackendId::parse(table.get::<String>("id")?)
                    .map_err(mlua::Error::external)?,
                command,
                environment,
            };
            let mut state = backend_state.borrow_mut();
            if state.acp.backends.iter().any(|existing| existing.id == backend.id) {
                return Err(configuration_error(format!(
                    "duplicate ACP backend {}",
                    backend.id
                )));
            }
            state.acp.backends.push(backend);
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

fn parse_standard_session(table: Table) -> mlua::Result<AcpStandardSessionConfig> {
    deny_unknown_fields(
        &table,
        &["role", "difficulty", "objective"],
        "standard_session",
    )?;
    let objective: String = table.get("objective")?;
    if objective.trim().is_empty() {
        return Err(configuration_error(
            "standard_session.objective must not be empty",
        ));
    }
    Ok(AcpStandardSessionConfig {
        role: RoleId::parse(table.get::<String>("role")?).map_err(mlua::Error::external)?,
        difficulty: parse_difficulty(&table.get::<String>("difficulty")?)?,
        objective,
    })
}

fn parse_environment(table: Table) -> mlua::Result<BTreeMap<String, String>> {
    let mut environment = BTreeMap::new();
    for pair in table.pairs::<Value, Value>() {
        let (key, value) = pair?;
        let Value::String(key) = key else {
            return Err(configuration_error("backend.environment keys must be strings"));
        };
        let Value::String(value) = value else {
            return Err(configuration_error("backend.environment values must be strings"));
        };
        let key = key.to_str()?.to_owned();
        if key.is_empty() || key.contains('=') || key.contains('\0') {
            return Err(configuration_error(format!(
                "invalid backend.environment key {key:?}"
            )));
        }
        let value = value.to_str()?.to_owned();
        if value.contains('\0') {
            return Err(configuration_error(format!(
                "backend.environment value for {key:?} contains a NUL byte"
            )));
        }
        environment.insert(key, value);
    }
    Ok(environment)
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

fn parse_difficulty(value: &str) -> mlua::Result<Difficulty> {
    match value.trim().to_ascii_lowercase().as_str() {
        "d0" => Ok(Difficulty::D0),
        "d1" => Ok(Difficulty::D1),
        "d2" => Ok(Difficulty::D2),
        "d3" => Ok(Difficulty::D3),
        "d4" => Ok(Difficulty::D4),
        _ => Err(configuration_error(format!(
            "unsupported difficulty {value:?}; expected d0, d1, d2, d3, or d4"
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
