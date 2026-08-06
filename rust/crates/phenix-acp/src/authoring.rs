use crate::source;
use crate::{
    DefinitionSourceError, DefinitionSourceKind, PhenixAcpGatewayBuilder, RouterId, RoutingTable,
    WorkflowDefinition, WorkflowId,
};
use serde::Deserialize;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

const FORMATS: [DefinitionFormat; 4] = [
    DefinitionFormat::Markdown,
    DefinitionFormat::Json,
    DefinitionFormat::Toml,
    DefinitionFormat::Ron,
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DefinitionFormat {
    Markdown,
    Json,
    Toml,
    Ron,
}

impl DefinitionFormat {
    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension.trim_start_matches('.').to_ascii_lowercase().as_str() {
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Definition {
    Workflow(WorkflowDefinition),
    RoutingTable(RoutingTable),
}

impl Definition {
    pub fn kind(&self) -> DefinitionSourceKind {
        match self {
            Self::Workflow(_) => DefinitionSourceKind::Workflow,
            Self::RoutingTable(_) => DefinitionSourceKind::Router,
        }
    }
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
        expected: DefinitionSourceKind,
        actual: DefinitionSourceKind,
    },
    DuplicateDefinition {
        kind: DefinitionSourceKind,
        id: String,
    },
    Gateway(String),
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
                write!(formatter, "expected {expected} source, found {actual} source")
            }
            Self::DuplicateDefinition { kind, id } => {
                write!(formatter, "duplicate {kind} definition {id}")
            }
            Self::Gateway(message) => formatter.write_str(message),
        }
    }
}

impl Error for DefinitionParseError {}

#[derive(Clone, Debug, Default)]
pub struct Definitions {
    inner: source::DefinitionSources,
}

impl Definitions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, source_text: &str) -> Result<DefinitionSourceKind, DefinitionParseError> {
        let (_, normalized, definition) = parse_auto(source_text)?;
        let kind = definition.kind();
        self.inner
            .add(&normalized)
            .map_err(map_collection_error)?;
        Ok(kind)
    }

    pub fn add_with_format(
        &mut self,
        source_text: &str,
        format: DefinitionFormat,
    ) -> Result<DefinitionSourceKind, DefinitionParseError> {
        let (normalized, definition) = parse_with_format(source_text, format)?;
        let kind = definition.kind();
        self.inner
            .add(&normalized)
            .map_err(map_collection_error)?;
        Ok(kind)
    }

    pub fn add_workflow(
        &mut self,
        source_text: &str,
    ) -> Result<WorkflowId, DefinitionParseError> {
        let (_, normalized, definition) = parse_auto(source_text)?;
        require_kind(&definition, DefinitionSourceKind::Workflow)?;
        self.inner
            .add_workflow(&normalized)
            .map_err(map_collection_error)
    }

    pub fn add_workflow_with_format(
        &mut self,
        source_text: &str,
        format: DefinitionFormat,
    ) -> Result<WorkflowId, DefinitionParseError> {
        let (normalized, definition) = parse_with_format(source_text, format)?;
        require_kind(&definition, DefinitionSourceKind::Workflow)?;
        self.inner
            .add_workflow(&normalized)
            .map_err(map_collection_error)
    }

    pub fn add_routing_table(
        &mut self,
        source_text: &str,
    ) -> Result<RouterId, DefinitionParseError> {
        let (_, normalized, definition) = parse_auto(source_text)?;
        require_kind(&definition, DefinitionSourceKind::Router)?;
        self.inner
            .add_router(&normalized)
            .map_err(map_collection_error)
    }

    pub fn add_routing_table_with_format(
        &mut self,
        source_text: &str,
        format: DefinitionFormat,
    ) -> Result<RouterId, DefinitionParseError> {
        let (normalized, definition) = parse_with_format(source_text, format)?;
        require_kind(&definition, DefinitionSourceKind::Router)?;
        self.inner
            .add_router(&normalized)
            .map_err(map_collection_error)
    }

    pub fn workflows(&self) -> impl ExactSizeIterator<Item = &WorkflowDefinition> {
        self.inner.workflows()
    }

    pub fn routing_tables(&self) -> impl ExactSizeIterator<Item = &RoutingTable> {
        self.inner.routers()
    }

    pub fn register(
        self,
        builder: PhenixAcpGatewayBuilder,
    ) -> Result<PhenixAcpGatewayBuilder, DefinitionParseError> {
        self.inner
            .register(builder)
            .map_err(|error| DefinitionParseError::Gateway(error.to_string()))
    }
}

pub fn parse_definition(source_text: &str) -> Result<Definition, DefinitionParseError> {
    parse_auto(source_text).map(|(_, _, definition)| definition)
}

pub fn parse_definition_with_format(
    source_text: &str,
    format: DefinitionFormat,
) -> Result<Definition, DefinitionParseError> {
    parse_with_format(source_text, format).map(|(_, definition)| definition)
}

pub fn parse_workflow(source_text: &str) -> Result<WorkflowDefinition, DefinitionParseError> {
    match parse_definition(source_text)? {
        Definition::Workflow(workflow) => Ok(workflow),
        Definition::RoutingTable(_) => Err(DefinitionParseError::UnexpectedKind {
            expected: DefinitionSourceKind::Workflow,
            actual: DefinitionSourceKind::Router,
        }),
    }
}

pub fn parse_workflow_with_format(
    source_text: &str,
    format: DefinitionFormat,
) -> Result<WorkflowDefinition, DefinitionParseError> {
    match parse_definition_with_format(source_text, format)? {
        Definition::Workflow(workflow) => Ok(workflow),
        Definition::RoutingTable(_) => Err(DefinitionParseError::UnexpectedKind {
            expected: DefinitionSourceKind::Workflow,
            actual: DefinitionSourceKind::Router,
        }),
    }
}

pub fn parse_routing_table(source_text: &str) -> Result<RoutingTable, DefinitionParseError> {
    match parse_definition(source_text)? {
        Definition::RoutingTable(router) => Ok(router),
        Definition::Workflow(_) => Err(DefinitionParseError::UnexpectedKind {
            expected: DefinitionSourceKind::Router,
            actual: DefinitionSourceKind::Workflow,
        }),
    }
}

pub fn parse_routing_table_with_format(
    source_text: &str,
    format: DefinitionFormat,
) -> Result<RoutingTable, DefinitionParseError> {
    match parse_definition_with_format(source_text, format)? {
        Definition::RoutingTable(router) => Ok(router),
        Definition::Workflow(_) => Err(DefinitionParseError::UnexpectedKind {
            expected: DefinitionSourceKind::Router,
            actual: DefinitionSourceKind::Workflow,
        }),
    }
}

fn require_kind(
    definition: &Definition,
    expected: DefinitionSourceKind,
) -> Result<(), DefinitionParseError> {
    let actual = definition.kind();
    if actual == expected {
        Ok(())
    } else {
        Err(DefinitionParseError::UnexpectedKind { expected, actual })
    }
}

fn parse_auto(
    source_text: &str,
) -> Result<(DefinitionFormat, String, Definition), DefinitionParseError> {
    let mut attempts = Vec::with_capacity(FORMATS.len());
    for format in FORMATS {
        match parse_with_format(source_text, format) {
            Ok((normalized, definition)) => return Ok((format, normalized, definition)),
            Err(DefinitionParseError::Invalid { message, .. }) => attempts.push(FormatAttempt {
                format,
                message,
            }),
            Err(other) => attempts.push(FormatAttempt {
                format,
                message: other.to_string(),
            }),
        }
    }
    Err(DefinitionParseError::AutoDetect { attempts })
}

fn parse_with_format(
    source_text: &str,
    format: DefinitionFormat,
) -> Result<(String, Definition), DefinitionParseError> {
    let normalized = normalize_source(source_text, format)?;
    let definition = match source::parse_definition(&normalized)
        .map_err(|error| invalid(format, error.to_string()))?
    {
        source::ParsedDefinition::Workflow(workflow) => Definition::Workflow(workflow),
        source::ParsedDefinition::Router(router) => Definition::RoutingTable(router),
    };
    Ok((normalized, definition))
}

fn normalize_source(
    source_text: &str,
    format: DefinitionFormat,
) -> Result<String, DefinitionParseError> {
    match format {
        DefinitionFormat::Markdown => Ok(source_text.to_owned()),
        DefinitionFormat::Json => serde_json::from_str::<StructuredDefinition>(source_text)
            .map_err(|error| invalid(format, error.to_string()))?
            .into_markdown(format),
        DefinitionFormat::Toml => toml::from_str::<StructuredDefinition>(source_text)
            .map_err(|error| invalid(format, error.to_string()))?
            .into_markdown(format),
        DefinitionFormat::Ron => ron::from_str::<StructuredDefinition>(source_text)
            .map_err(|error| invalid(format, error.to_string()))?
            .into_markdown(format),
    }
}

fn invalid(format: DefinitionFormat, message: impl Into<String>) -> DefinitionParseError {
    DefinitionParseError::Invalid {
        format,
        message: message.into(),
    }
}

fn map_collection_error(error: DefinitionSourceError) -> DefinitionParseError {
    match error {
        DefinitionSourceError::DuplicateDefinition { kind, id } => {
            DefinitionParseError::DuplicateDefinition { kind, id }
        }
        other => DefinitionParseError::Invalid {
            format: DefinitionFormat::Markdown,
            message: other.to_string(),
        },
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum StructuredDefinition {
    Workflow {
        title: String,
        id: String,
        steps: Vec<StructuredWorkflowStep>,
    },
    RoutingTable {
        title: String,
        id: String,
        routes: Vec<StructuredRoutingRule>,
    },
}

impl StructuredDefinition {
    fn into_markdown(self, format: DefinitionFormat) -> Result<String, DefinitionParseError> {
        match self {
            Self::Workflow { title, id, steps } => {
                let title = heading(&title, format)?;
                let id = metadata_value(&id, "id", format)?;
                let mut output = format!(
                    "# {title}\n\n```phenix-workflow\nid: {id}\n```\n\n## Steps\n\n| Key | Parent | Role | Objective |\n|---|---|---|---|\n"
                );
                for step in steps {
                    let key = table_cell(&step.key, "steps.key", format)?;
                    let parent = table_cell(step.parent.as_deref().unwrap_or(""), "steps.parent", format)?;
                    let role = table_cell(&step.role, "steps.role", format)?;
                    let objective = table_cell(&step.objective, "steps.objective", format)?;
                    output.push_str(&format!(
                        "| {key} | {parent} | {role} | {objective} |\n"
                    ));
                }
                Ok(output)
            }
            Self::RoutingTable { title, id, routes } => {
                let title = heading(&title, format)?;
                let id = metadata_value(&id, "id", format)?;
                let mut output = format!(
                    "# {title}\n\n```phenix-router\nid: {id}\n```\n\n## Routes\n\n| Role | Workflow | Target | Explanation |\n|---|---|---|---|\n"
                );
                for route in routes {
                    let role = table_cell(&route.role, "routes.role", format)?;
                    let workflow = table_cell(&route.workflow, "routes.workflow", format)?;
                    let target = table_cell(&route.target, "routes.target", format)?;
                    let explanation =
                        table_cell(&route.explanation, "routes.explanation", format)?;
                    output.push_str(&format!(
                        "| {role} | {workflow} | {target} | {explanation} |\n"
                    ));
                }
                Ok(output)
            }
        }
    }
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
    target: String,
    explanation: String,
}

fn heading(value: &str, format: DefinitionFormat) -> Result<&str, DefinitionParseError> {
    if value.trim() != value
        || value.is_empty()
        || value.contains(['\n', '\r'])
        || value.starts_with('#')
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
    if value.trim() != value || value.is_empty() || value.contains(['\n', '\r']) {
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
        || value.contains(['\n', '\r', '|'])
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
      "target": "pi/openai/gpt-5.6-sol",
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
  routes: [
    (
      role: "*",
      workflow: "*",
      target: "pi/openai/gpt-5.6-sol",
      explanation: "Default route",
    ),
  ],
)"#;

    #[test]
    fn parser_returns_semantic_definition_variants() {
        assert!(matches!(
            parse_definition(WORKFLOW_MD).expect("workflow"),
            Definition::Workflow(_)
        ));
        assert!(matches!(
            parse_definition(ROUTER_JSON).expect("routing table"),
            Definition::RoutingTable(_)
        ));
    }

    #[test]
    fn explicit_formats_parse_json_toml_and_ron() {
        assert!(parse_routing_table_with_format(ROUTER_JSON, DefinitionFormat::Json).is_ok());
        assert!(parse_workflow_with_format(WORKFLOW_TOML, DefinitionFormat::Toml).is_ok());
        assert!(parse_routing_table_with_format(ROUTER_RON, DefinitionFormat::Ron).is_ok());
    }

    #[test]
    fn automatic_detection_tries_all_supported_formats() {
        assert!(parse_workflow(WORKFLOW_TOML).is_ok());
        assert!(parse_routing_table(ROUTER_RON).is_ok());
        let error = parse_definition("not a definition").expect_err("invalid source");
        let DefinitionParseError::AutoDetect { attempts } = error else {
            panic!("auto-detection error expected")
        };
        assert_eq!(attempts.len(), FORMATS.len());
    }

    #[test]
    fn typed_entry_points_reject_the_other_definition_kind() {
        assert!(parse_workflow(WORKFLOW_MD).is_ok());
        assert!(parse_routing_table(ROUTER_JSON).is_ok());
        assert!(parse_workflow(ROUTER_JSON).is_err());
        assert!(parse_routing_table(WORKFLOW_MD).is_err());
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
