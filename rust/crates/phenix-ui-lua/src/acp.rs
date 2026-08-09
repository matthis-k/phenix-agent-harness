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
                id: BackendId::parse(table.get::<String>("id")?).map_err(mlua::Error::external)?,
                command,
                environment,
            };
            let mut state = backend_state.borrow_mut();
            if state
                .acp
                .backends
                .iter()
                .any(|existing| existing.id == backend.id)
            {
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
            return Err(configuration_error(
                "backend.environment keys must be strings",
            ));
        };
        let Value::String(value) = value else {
            return Err(configuration_error(
                "backend.environment values must be strings",
            ));
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
        let source = parse_definition_source(value, kind)?;
        let input = match kind {
            DefinitionInputKind::Workflow => AcpDefinitionInput::Workflow(source),
            DefinitionInputKind::RoutingTable => AcpDefinitionInput::RoutingTable(source),
        };
        state.borrow_mut().acp.definitions.push(input);
        Ok(())
    })
    .map_err(runtime_error)
}

fn parse_definition_source(
    value: Value,
    kind: DefinitionInputKind,
) -> mlua::Result<AcpDefinitionSource> {
    match value {
        Value::String(path) => parse_path_definition(path.to_str()?.as_ref()),
        Value::Table(table) => {
            let path = table.get::<Option<String>>("path")?;
            let source = table.get::<Option<String>>("source")?;
            if path.is_some() || source.is_some() {
                return parse_source_descriptor(table, path, source);
            }
            match kind {
                DefinitionInputKind::Workflow => parse_structured_workflow(table),
                DefinitionInputKind::RoutingTable => parse_structured_routing_table(table),
            }
        }
        _ => Err(configuration_error(
            "definition input must be a relative path string or a table",
        )),
    }
}

fn parse_path_definition(path: &str) -> mlua::Result<AcpDefinitionSource> {
    let path = path.trim();
    if path.is_empty() {
        return Err(configuration_error("definition path must not be empty"));
    }
    Ok(AcpDefinitionSource::Path(PathBuf::from(path)))
}

fn parse_source_descriptor(
    table: Table,
    path: Option<String>,
    source: Option<String>,
) -> mlua::Result<AcpDefinitionSource> {
    deny_unknown_fields(&table, &["path", "source", "format"], "definition")?;
    match (path, source) {
        (Some(path), None) => {
            if table.get::<Option<String>>("format")?.is_some() {
                return Err(configuration_error(
                    "path definitions infer their format from the extension",
                ));
            }
            parse_path_definition(&path)
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
        (None, None) => unreachable!("descriptor parsing requires path or source"),
    }
}

fn parse_structured_workflow(table: Table) -> mlua::Result<AcpDefinitionSource> {
    deny_unknown_fields(&table, &["id", "title", "steps"], "workflow definition")?;
    let id = authoring_atom(&table.get::<String>("id")?, "workflow.id")?;
    let title = authoring_title(&table.get::<String>("title")?, "workflow.title")?;
    let steps: Table = table.get("steps")?;

    let mut rows = Vec::new();
    for step in steps.sequence_values::<Table>() {
        let step = step?;
        deny_unknown_fields(
            &step,
            &["key", "parent", "role", "objective"],
            "workflow step",
        )?;
        let key = authoring_cell(&step.get::<String>("key")?, "workflow step.key")?;
        let parent = step
            .get::<Option<String>>("parent")?
            .map(|parent| authoring_cell(&parent, "workflow step.parent"))
            .transpose()?
            .unwrap_or_else(|| "-".to_owned());
        let role = authoring_cell(&step.get::<String>("role")?, "workflow step.role")?;
        let objective =
            authoring_cell(&step.get::<String>("objective")?, "workflow step.objective")?;
        rows.push(format!("| {key} | {parent} | {role} | {objective} |"));
    }
    if rows.is_empty() {
        return Err(configuration_error(
            "workflow definition requires at least one step",
        ));
    }

    Ok(inline_markdown(format!(
        "# {title}\n\n```phenix-workflow\nid: {id}\n```\n\n## Steps\n\n| Key | Parent | Role | Objective |\n|---|---|---|---|\n{}\n",
        rows.join("\n")
    )))
}

fn parse_structured_routing_table(table: Table) -> mlua::Result<AcpDefinitionSource> {
    deny_unknown_fields(
        &table,
        &["id", "title", "routes"],
        "routing table definition",
    )?;
    let id = authoring_atom(&table.get::<String>("id")?, "routing_table.id")?;
    let title = authoring_title(&table.get::<String>("title")?, "routing_table.title")?;
    let routes: Table = table.get("routes")?;

    let mut rows = Vec::new();
    for route in routes.sequence_values::<Table>() {
        let route = route?;
        deny_unknown_fields(
            &route,
            &[
                "role",
                "workflow",
                "d0",
                "d1",
                "d2",
                "d3",
                "d4",
                "explanation",
            ],
            "routing rule",
        )?;
        rows.push(format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} |",
            authoring_cell(&route.get::<String>("role")?, "routing rule.role")?,
            authoring_cell(&route.get::<String>("workflow")?, "routing rule.workflow")?,
            authoring_cell(&route.get::<String>("d0")?, "routing rule.d0")?,
            authoring_cell(&route.get::<String>("d1")?, "routing rule.d1")?,
            authoring_cell(&route.get::<String>("d2")?, "routing rule.d2")?,
            authoring_cell(&route.get::<String>("d3")?, "routing rule.d3")?,
            authoring_cell(&route.get::<String>("d4")?, "routing rule.d4")?,
            authoring_cell(
                &route.get::<String>("explanation")?,
                "routing rule.explanation"
            )?,
        ));
    }
    if rows.is_empty() {
        return Err(configuration_error(
            "routing table definition requires at least one route",
        ));
    }

    Ok(inline_markdown(format!(
        "# {title}\n\n```phenix-router\nid: {id}\n```\n\n## Routes\n\n| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |\n|---|---|---|---|---|---|---|---|\n{}\n",
        rows.join("\n")
    )))
}

fn inline_markdown(source: String) -> AcpDefinitionSource {
    AcpDefinitionSource::Inline {
        source,
        format: Some(DefinitionFormat::Markdown),
    }
}

fn authoring_atom(value: &str, field: &str) -> mlua::Result<String> {
    let value = authoring_cell(value, field)?;
    if value.chars().any(char::is_whitespace) {
        return Err(configuration_error(format!(
            "{field} must not contain whitespace"
        )));
    }
    Ok(value)
}

fn authoring_title(value: &str, field: &str) -> mlua::Result<String> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('#') || value.contains(['\r', '\n']) {
        return Err(configuration_error(format!(
            "{field} must be a non-empty single-line heading without a leading '#'"
        )));
    }
    Ok(value.to_owned())
}

fn authoring_cell(value: &str, field: &str) -> mlua::Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(configuration_error(format!("{field} must not be empty")));
    }
    if value.contains('|') || value.contains(['\r', '\n']) || value.chars().any(char::is_control) {
        return Err(configuration_error(format!(
            "{field} must be a single Markdown-table-safe line"
        )));
    }
    Ok(value.to_owned())
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

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_acp::{parse_routing_table_with_format, parse_workflow_with_format};

    #[test]
    fn structured_lua_workflow_is_a_first_class_definition_source() {
        let lua = Lua::new();
        let table: Table = lua
            .load(
                r#"
return {
  id = "workflow.test",
  title = "Test workflow",
  steps = {
    {
      key = "inspect",
      role = "scout",
      objective = "Inspect {objective}",
    },
    {
      key = "verify",
      parent = "inspect",
      role = "verifier",
      objective = "Verify {objective}",
    },
  },
}
"#,
            )
            .eval()
            .expect("workflow table");
        let source = parse_definition_source(Value::Table(table), DefinitionInputKind::Workflow)
            .expect("structured workflow source");
        let AcpDefinitionSource::Inline {
            source,
            format: Some(DefinitionFormat::Markdown),
        } = source
        else {
            panic!("structured workflow must become inline markdown")
        };
        let workflow = parse_workflow_with_format(&source, DefinitionFormat::Markdown)
            .expect("canonical workflow parser");
        assert_eq!(workflow.id().as_str(), "workflow.test");
        assert_eq!(workflow.steps().len(), 2);
    }

    #[test]
    fn structured_lua_routing_table_carries_all_difficulties() {
        let lua = Lua::new();
        let table: Table = lua
            .load(
                r#"
return {
  id = "router.test",
  title = "Test router",
  routes = {
    {
      role = "*",
      workflow = "*",
      d0 = "pi/provider/model/minimal",
      d1 = "pi/provider/model/low",
      d2 = "pi/provider/model/medium",
      d3 = "pi/provider/model/high",
      d4 = "pi/provider/model/max",
      explanation = "fallback",
    },
  },
}
"#,
            )
            .eval()
            .expect("routing table");
        let source =
            parse_definition_source(Value::Table(table), DefinitionInputKind::RoutingTable)
                .expect("structured routing source");
        let AcpDefinitionSource::Inline {
            source,
            format: Some(DefinitionFormat::Markdown),
        } = source
        else {
            panic!("structured routing table must become inline markdown")
        };
        let routing = parse_routing_table_with_format(&source, DefinitionFormat::Markdown)
            .expect("canonical routing parser");
        assert_eq!(routing.id().as_str(), "router.test");
        assert_eq!(routing.rules().len(), 1);
    }
}
