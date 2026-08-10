use crate::source;
use crate::{
    GatewayError, PhenixAcpGatewayBuilder, RouterId, RoutingTable, WorkflowDefinition, WorkflowId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

const FORMATS: [DefinitionFormat; 4] = [
    DefinitionFormat::Markdown,
    DefinitionFormat::Json,
    DefinitionFormat::Toml,
    DefinitionFormat::Ron,
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DefinitionFormat {
    Markdown,
    Json,
    Toml,
    Ron,
}

impl DefinitionFormat {
    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "md" | "markdown" => Some(Self::Markdown),
            "json" => Some(Self::Json),
            "toml" => Some(Self::Toml),
            "ron" => Some(Self::Ron),
            _ => None,
        }
    }
}

impl Display for DefinitionFormat {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Markdown => formatter.write_str("markdown"),
            Self::Json => formatter.write_str("json"),
            Self::Toml => formatter.write_str("toml"),
            Self::Ron => formatter.write_str("ron"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DefinitionKind {
    Workflow,
    RoutingTable,
}

impl Display for DefinitionKind {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Workflow => formatter.write_str("workflow"),
            Self::RoutingTable => formatter.write_str("routing table"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Definition {
    Workflow(WorkflowDefinition),
    RoutingTable(RoutingTable),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormatAttempt {
    pub format: DefinitionFormat,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DefinitionParseError {
    Invalid {
        format: DefinitionFormat,
        message: String,
    },
    AutoDetect {
        attempts: Vec<FormatAttempt>,
    },
    UnexpectedKind {
        expected: DefinitionKind,
        actual: DefinitionKind,
    },
    DuplicateDefinition {
        kind: DefinitionKind,
        id: String,
    },
}

impl Display for DefinitionParseError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid { format, message } => {
                write!(formatter, "invalid {format} definition: {message}")
            }
            Self::AutoDetect { attempts } => {
                formatter.write_str("definition did not match any supported format")?;
                for attempt in attempts {
                    write!(formatter, "; {}: {}", attempt.format, attempt.message)?;
                }
                Ok(())
            }
            Self::UnexpectedKind { expected, actual } => {
                write!(
                    formatter,
                    "expected {expected} source, found {actual} source"
                )
            }
            Self::DuplicateDefinition { kind, id } => {
                write!(formatter, "duplicate {kind} definition {id}")
            }
        }
    }
}

impl Error for DefinitionParseError {}

#[derive(Clone, Debug, Default)]
pub struct Definitions {
    workflows: BTreeMap<WorkflowId, WorkflowDefinition>,
    routing_tables: BTreeMap<RouterId, RoutingTable>,
}

impl Definitions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_workflow(&mut self, source: &str) -> Result<WorkflowId, DefinitionParseError> {
        let workflow = parse_workflow(source)?;
        self.insert_workflow(workflow)
    }

    pub fn add_workflow_with_format(
        &mut self,
        source: &str,
        format: DefinitionFormat,
    ) -> Result<WorkflowId, DefinitionParseError> {
        let workflow = parse_workflow_with_format(source, format)?;
        self.insert_workflow(workflow)
    }

    pub fn add_routing_table(&mut self, source: &str) -> Result<RouterId, DefinitionParseError> {
        let routing_table = parse_routing_table(source)?;
        self.insert_routing_table(routing_table)
    }

    pub fn add_routing_table_with_format(
        &mut self,
        source: &str,
        format: DefinitionFormat,
    ) -> Result<RouterId, DefinitionParseError> {
        let routing_table = parse_routing_table_with_format(source, format)?;
        self.insert_routing_table(routing_table)
    }

    pub fn workflows(&self) -> impl ExactSizeIterator<Item = &WorkflowDefinition> {
        self.workflows.values()
    }

    pub fn routing_tables(&self) -> impl ExactSizeIterator<Item = &RoutingTable> {
        self.routing_tables.values()
    }

    pub fn register(
        self,
        mut builder: PhenixAcpGatewayBuilder,
    ) -> Result<PhenixAcpGatewayBuilder, GatewayError> {
        for (id, routing_table) in self.routing_tables {
            builder = builder.router(id, routing_table)?;
        }
        for (id, workflow) in self.workflows {
            builder = builder.workflow(id, workflow)?;
        }
        Ok(builder)
    }

    fn insert_workflow(
        &mut self,
        workflow: WorkflowDefinition,
    ) -> Result<WorkflowId, DefinitionParseError> {
        let id = workflow.id().clone();
        if self.workflows.insert(id.clone(), workflow).is_some() {
            return Err(DefinitionParseError::DuplicateDefinition {
                kind: DefinitionKind::Workflow,
                id: id.to_string(),
            });
        }
        Ok(id)
    }

    fn insert_routing_table(
        &mut self,
        routing_table: RoutingTable,
    ) -> Result<RouterId, DefinitionParseError> {
        let id = routing_table.id().clone();
        if self
            .routing_tables
            .insert(id.clone(), routing_table)
            .is_some()
        {
            return Err(DefinitionParseError::DuplicateDefinition {
                kind: DefinitionKind::RoutingTable,
                id: id.to_string(),
            });
        }
        Ok(id)
    }
}

fn parse_definition(source: &str) -> Result<Definition, DefinitionParseError> {
    let mut attempts = Vec::with_capacity(FORMATS.len());
    for format in FORMATS {
        match parse_definition_with_format(source, format) {
            Ok(definition) => return Ok(definition),
            Err(DefinitionParseError::Invalid { message, .. }) => {
                attempts.push(FormatAttempt { format, message });
            }
            Err(error) => attempts.push(FormatAttempt {
                format,
                message: error.to_string(),
            }),
        }
    }
    Err(DefinitionParseError::AutoDetect { attempts })
}

fn parse_definition_with_format(
    source: &str,
    format: DefinitionFormat,
) -> Result<Definition, DefinitionParseError> {
    let markdown = match format {
        DefinitionFormat::Markdown => source.to_owned(),
        DefinitionFormat::Json => decode_structured(
            serde_json::from_str(source).map_err(|error| invalid(format, error.to_string()))?,
            format,
        )?,
        DefinitionFormat::Toml => decode_structured(
            toml::from_str(source).map_err(|error| invalid(format, error.to_string()))?,
            format,
        )?,
        DefinitionFormat::Ron => decode_structured(
            ron::from_str(source).map_err(|error| invalid(format, error.to_string()))?,
            format,
        )?,
    };
    match source::parse_definition(&markdown).map_err(|error| invalid(format, error.to_string()))? {
        source::ParsedDefinition::Workflow(workflow) => Ok(Definition::Workflow(workflow)),
        source::ParsedDefinition::Router(routing_table) => {
            Ok(Definition::RoutingTable(routing_table))
        }
    }
}

pub fn parse_workflow(source: &str) -> Result<WorkflowDefinition, DefinitionParseError> {
    require_workflow(parse_definition(source)?)
}

pub fn parse_workflow_with_format(
    source: &str,
    format: DefinitionFormat,
) -> Result<WorkflowDefinition, DefinitionParseError> {
    require_workflow(parse_definition_with_format(source, format)?)
}

pub fn parse_routing_table(source: &str) -> Result<RoutingTable, DefinitionParseError> {
    require_routing_table(parse_definition(source)?)
}

pub fn parse_routing_table_with_format(
    source: &str,
    format: DefinitionFormat,
) -> Result<RoutingTable, DefinitionParseError> {
    require_routing_table(parse_definition_with_format(source, format)?)
}

fn require_workflow(definition: Definition) -> Result<WorkflowDefinition, DefinitionParseError> {
    match definition {
        Definition::Workflow(workflow) => Ok(workflow),
        Definition::RoutingTable(_) => Err(DefinitionParseError::UnexpectedKind {
            expected: DefinitionKind::Workflow,
            actual: DefinitionKind::RoutingTable,
        }),
    }
}

fn require_routing_table(definition: Definition) -> Result<RoutingTable, DefinitionParseError> {
    match definition {
        Definition::RoutingTable(routing_table) => Ok(routing_table),
        Definition::Workflow(_) => Err(DefinitionParseError::UnexpectedKind {
            expected: DefinitionKind::RoutingTable,
            actual: DefinitionKind::Workflow,
        }),
    }
}

fn invalid(format: DefinitionFormat, message: impl Into<String>) -> DefinitionParseError {
    DefinitionParseError::Invalid {
        format,
        message: message.into(),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredDefinition {
    kind: String,
    title: String,
    id: String,
    #[serde(default)]
    steps: Option<Vec<StructuredWorkflowStep>>,
    #[serde(default)]
    routes: Option<Vec<StructuredRoutingRule>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredWorkflowStep {
    key: String,
    #[serde(default)]
    parent: Option<String>,
    role: String,
    objective: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct StructuredRoutingRule {
    role: String,
    workflow: String,
    d0: String,
    d1: String,
    d2: String,
    d3: String,
    d4: String,
    explanation: String,
}

fn decode_structured(
    definition: StructuredDefinition,
    format: DefinitionFormat,
) -> Result<String, DefinitionParseError> {
    let title = heading(&definition.title, format)?;
    let id = metadata_value(&definition.id, "id", format)?;
    match definition.kind.as_str() {
        "workflow" => {
            if definition.routes.is_some() {
                return Err(invalid(
                    format,
                    "workflow definitions must not contain routes",
                ));
            }
            let steps = definition
                .steps
                .ok_or_else(|| invalid(format, "workflow definitions require steps"))?;
            let mut output = format!(
                "# {title}\n\n```phenix-workflow\nid: {id}\n```\n\n## Steps\n\n| Key | Parent | Role | Objective |\n|---|---|---|---|\n"
            );
            for step in steps {
                let key = table_cell(&step.key, "steps.key", format)?;
                let parent =
                    table_cell(step.parent.as_deref().unwrap_or(""), "steps.parent", format)?;
                let role = table_cell(&step.role, "steps.role", format)?;
                let objective = table_cell(&step.objective, "steps.objective", format)?;
                output.push_str(&format!("| {key} | {parent} | {role} | {objective} |\n"));
            }
            Ok(output)
        }
        "routing_table" => {
            if definition.steps.is_some() {
                return Err(invalid(
                    format,
                    "routing table definitions must not contain steps",
                ));
            }
            let routes = definition
                .routes
                .ok_or_else(|| invalid(format, "routing table definitions require routes"))?;
            let mut output = format!(
                "# {title}\n\n```phenix-router\nid: {id}\n```\n\n## Routes\n\n| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |\n|---|---|---|---|---|---|---|---|\n"
            );
            for route in routes {
                let role = table_cell(&route.role, "routes.role", format)?;
                let workflow = table_cell(&route.workflow, "routes.workflow", format)?;
                let d0 = table_cell(&route.d0, "routes.d0", format)?;
                let d1 = table_cell(&route.d1, "routes.d1", format)?;
                let d2 = table_cell(&route.d2, "routes.d2", format)?;
                let d3 = table_cell(&route.d3, "routes.d3", format)?;
                let d4 = table_cell(&route.d4, "routes.d4", format)?;
                let explanation = table_cell(&route.explanation, "routes.explanation", format)?;
                output.push_str(&format!(
                    "| {role} | {workflow} | {d0} | {d1} | {d2} | {d3} | {d4} | {explanation} |\n"
                ));
            }
            Ok(output)
        }
        kind => Err(invalid(
            format,
            format!("unknown definition kind {kind:?}; expected workflow or routing_table"),
        )),
    }
}

fn heading(value: &str, format: DefinitionFormat) -> Result<&str, DefinitionParseError> {
    if value.trim() != value || value.is_empty() || has_line_break(value) || value.starts_with('#')
    {
        return Err(invalid(
            format,
            "title must be a non-empty single line without surrounding whitespace or a leading '#'",
        ));
    }
    Ok(value)
}

fn metadata_value<'a>(
    value: &'a str,
    field: &'static str,
    format: DefinitionFormat,
) -> Result<&'a str, DefinitionParseError> {
    if value.trim() != value || value.is_empty() || has_line_break(value) {
        return Err(invalid(
            format,
            format!("{field} must be a non-empty single line without surrounding whitespace"),
        ));
    }
    Ok(value)
}

fn table_cell<'a>(
    value: &'a str,
    field: &'static str,
    format: DefinitionFormat,
) -> Result<&'a str, DefinitionParseError> {
    if value.trim() != value
        || has_line_break(value)
        || value.contains('|')
        || value.starts_with('`')
        || value.ends_with('`')
    {
        return Err(invalid(
            format,
            format!(
                "{field} must be a single Markdown-table-safe value without surrounding whitespace, pipes, or boundary backticks"
            ),
        ));
    }
    Ok(value)
}

fn has_line_break(value: &str) -> bool {
    value.contains('\n') || value.contains('\r')
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORKFLOW_MD: &str = r#"# Implementation

```phenix-workflow
id: phenix.implement
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| implement | | implementer | Implement {objective} |
"#;

    const ROUTER_JSON: &str = r#"{
  "kind": "routing_table",
  "title": "Default routing",
  "id": "phenix.default",
  "routes": [
    {
      "role": "*",
      "workflow": "*",
      "d0": "pi/openai/gpt-5.6-sol/minimal",
      "d1": "pi/openai/gpt-5.6-sol/low",
      "d2": "pi/openai/gpt-5.6-sol/medium",
      "d3": "pi/openai/gpt-5.6-sol/high",
      "d4": "pi/openai/gpt-5.6-sol/max",
      "explanation": "Default route"
    }
  ]
}"#;

    const WORKFLOW_TOML: &str = r#"kind = "workflow"
title = "Implementation"
id = "phenix.implement"

[[steps]]
key = "implement"
role = "implementer"
objective = "Implement {objective}"
"#;

    const ROUTER_RON: &str = r#"(
  kind: "routing_table",
  title: "Default routing",
  id: "phenix.default",
  routes: Some([
    (
      role: "*",
      workflow: "*",
      d0: "pi/openai/gpt-5.6-sol/minimal",
      d1: "pi/openai/gpt-5.6-sol/low",
      d2: "pi/openai/gpt-5.6-sol/medium",
      d3: "pi/openai/gpt-5.6-sol/high",
      d4: "pi/openai/gpt-5.6-sol/max",
      explanation: "Default route",
    ),
  ]),
)"#;

    #[test]
    fn explicit_formats_parse_json_toml_and_ron() {
        assert!(parse_routing_table_with_format(ROUTER_JSON, DefinitionFormat::Json).is_ok());
        assert!(parse_workflow_with_format(WORKFLOW_TOML, DefinitionFormat::Toml).is_ok());
        assert!(parse_routing_table_with_format(ROUTER_RON, DefinitionFormat::Ron).is_ok());
    }

    #[test]
    fn automatic_detection_accepts_supported_formats_and_rejects_invalid_sources() {
        assert!(parse_workflow(WORKFLOW_TOML).is_ok());
        assert!(parse_routing_table(ROUTER_RON).is_ok());
        assert!(matches!(
            parse_workflow("not a definition"),
            Err(DefinitionParseError::AutoDetect { .. })
        ));
    }

    #[test]
    fn typed_entry_points_reject_the_other_definition_kind() {
        assert!(parse_workflow(WORKFLOW_MD).is_ok());
        assert!(parse_routing_table(ROUTER_JSON).is_ok());
        assert!(parse_workflow(ROUTER_JSON).is_err());
        assert!(parse_routing_table(WORKFLOW_MD).is_err());
    }

    #[test]
    fn source_collection_rejects_duplicate_semantic_ids() {
        let mut definitions = Definitions::new();
        definitions
            .add_workflow(WORKFLOW_MD)
            .expect("first workflow");
        assert!(matches!(
            definitions.add_workflow(WORKFLOW_TOML),
            Err(DefinitionParseError::DuplicateDefinition { .. })
        ));
    }

    #[test]
    fn extensions_map_to_explicit_formats() {
        assert_eq!(
            DefinitionFormat::from_extension(".markdown"),
            Some(DefinitionFormat::Markdown)
        );
        assert_eq!(
            DefinitionFormat::from_extension("TOML"),
            Some(DefinitionFormat::Toml)
        );
        assert_eq!(DefinitionFormat::from_extension("yaml"), None);
    }
}
