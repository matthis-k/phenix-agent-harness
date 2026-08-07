use crate::{
    BackendId, GatewayError, IdError, ModelId, ModelSelection, ProviderId, RoleId, RouterId,
    RoutingDecision, RoutingRequest, SessionRouter, Workflow, WorkflowId, WorkflowPlan,
    WorkflowRequest,
};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

const OBJECTIVE_PLACEHOLDER: &str = "{objective}";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DefinitionSourceKind {
    Workflow,
    Router,
}

impl Display for DefinitionSourceKind {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Workflow => formatter.write_str("workflow"),
            Self::Router => formatter.write_str("router"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelTarget {
    backend: BackendId,
    provider: ProviderId,
    model: ModelId,
}

impl ModelTarget {
    pub fn new(backend: BackendId, provider: ProviderId, model: ModelId) -> Self {
        Self {
            backend,
            provider,
            model,
        }
    }

    pub fn parse(value: &str) -> Result<Self, DefinitionSourceError> {
        Self::parse_at(value, None)
    }

    pub fn backend(&self) -> &BackendId {
        &self.backend
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    pub fn model(&self) -> &ModelId {
        &self.model
    }

    fn parse_at(value: &str, line: Option<usize>) -> Result<Self, DefinitionSourceError> {
        let first = value
            .find('/')
            .ok_or_else(|| DefinitionSourceError::InvalidValue {
                line,
                field: "target",
                value: value.to_owned(),
                reason: "expected backend/provider/model".to_owned(),
            })?;
        let second = value[first + 1..]
            .find('/')
            .map(|offset| first + 1 + offset)
            .ok_or_else(|| DefinitionSourceError::InvalidValue {
                line,
                field: "target",
                value: value.to_owned(),
                reason: "expected backend/provider/model".to_owned(),
            })?;
        let backend = &value[..first];
        let provider = &value[first + 1..second];
        let model = &value[second + 1..];
        if backend.is_empty() || provider.is_empty() || model.is_empty() {
            return Err(DefinitionSourceError::InvalidValue {
                line,
                field: "target",
                value: value.to_owned(),
                reason: "backend, provider, and model must all be non-empty".to_owned(),
            });
        }
        Ok(Self {
            backend: parse_id(backend, line, "backend", BackendId::parse)?,
            provider: parse_id(provider, line, "provider", ProviderId::parse)?,
            model: parse_id(model, line, "model", ModelId::parse)?,
        })
    }
}

impl Display for ModelTarget {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}/{}/{}",
            self.backend, self.provider, self.model
        )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowStepDefinition {
    key: String,
    parent: Option<String>,
    role: RoleId,
    objective: String,
}

impl WorkflowStepDefinition {
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn parent(&self) -> Option<&str> {
        self.parent.as_deref()
    }

    pub fn role(&self) -> &RoleId {
        &self.role
    }

    pub fn objective(&self) -> &str {
        &self.objective
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowDefinition {
    id: WorkflowId,
    title: String,
    steps: Vec<WorkflowStepDefinition>,
}

impl WorkflowDefinition {
    pub fn id(&self) -> &WorkflowId {
        &self.id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn steps(&self) -> &[WorkflowStepDefinition] {
        &self.steps
    }
}

impl Workflow for WorkflowDefinition {
    fn plan(&self, request: &WorkflowRequest) -> Result<WorkflowPlan, GatewayError> {
        let mut plan = WorkflowPlan::builder();
        for step in &self.steps {
            plan = plan.step(
                step.key.clone(),
                step.parent.clone(),
                step.role.clone(),
                step.objective
                    .replace(OBJECTIVE_PLACEHOLDER, &request.objective),
            )?;
        }
        plan.build()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouteSelector<T> {
    Any,
    Exact(T),
}

impl<T: PartialEq> RouteSelector<T> {
    fn matches(&self, value: Option<&T>) -> bool {
        match self {
            Self::Any => true,
            Self::Exact(expected) => value.is_some_and(|value| value == expected),
        }
    }

    fn covers(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Any, _) => true,
            (Self::Exact(left), Self::Exact(right)) => left == right,
            (Self::Exact(_), Self::Any) => false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoutingRule {
    role: RouteSelector<RoleId>,
    workflow: RouteSelector<WorkflowId>,
    target: ModelTarget,
    explanation: String,
}

impl RoutingRule {
    pub fn role(&self) -> &RouteSelector<RoleId> {
        &self.role
    }

    pub fn workflow(&self) -> &RouteSelector<WorkflowId> {
        &self.workflow
    }

    pub fn target(&self) -> &ModelTarget {
        &self.target
    }

    pub fn explanation(&self) -> &str {
        &self.explanation
    }

    fn matches(&self, request: &RoutingRequest) -> bool {
        self.role.matches(Some(&request.role)) && self.workflow.matches(request.workflow.as_ref())
    }

    fn covers(&self, other: &Self) -> bool {
        self.role.covers(&other.role) && self.workflow.covers(&other.workflow)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoutingTable {
    id: RouterId,
    title: String,
    rules: Vec<RoutingRule>,
}

impl RoutingTable {
    pub fn id(&self) -> &RouterId {
        &self.id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn rules(&self) -> &[RoutingRule] {
        &self.rules
    }
}

impl SessionRouter for RoutingTable {
    fn route(&self, request: &RoutingRequest) -> Result<RoutingDecision, GatewayError> {
        let rule = self
            .rules
            .iter()
            .find(|rule| rule.matches(request))
            .ok_or_else(|| {
                GatewayError::routing(format!(
                    "router {} has no matching route for role {} and workflow {}",
                    self.id,
                    request.role,
                    request
                        .workflow
                        .as_ref()
                        .map_or("<none>", WorkflowId::as_str)
                ))
            })?;
        if !request
            .available_backends
            .iter()
            .any(|backend| backend == rule.target.backend())
        {
            return Err(GatewayError::routing(format!(
                "router {} selected backend {} which is not available in tree {}",
                self.id,
                rule.target.backend(),
                request.tree_id
            )));
        }
        Ok(RoutingDecision {
            backend: rule.target.backend().clone(),
            model: Some(ModelSelection {
                provider: rule.target.provider().clone(),
                model: rule.target.model().clone(),
            }),
            explanation: rule.explanation.clone(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ParsedDefinition {
    Workflow(WorkflowDefinition),
    Router(RoutingTable),
}

pub fn parse_definition(source: &str) -> Result<ParsedDefinition, DefinitionSourceError> {
    if source.trim().is_empty() {
        return Err(DefinitionSourceError::EmptyDocument);
    }
    if source
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(DefinitionSourceError::InvalidControlCharacter);
    }

    let mut cursor = SourceCursor::new(source);
    let (title_line, title_source) = cursor
        .next_nonblank()
        .ok_or(DefinitionSourceError::EmptyDocument)?;
    let title = title_source
        .strip_prefix("# ")
        .filter(|title| !title.trim().is_empty() && !title.starts_with('#'))
        .ok_or_else(|| DefinitionSourceError::UnexpectedLine {
            line: title_line,
            expected: "a non-empty level-one Markdown heading",
            found: title_source.to_owned(),
        })?
        .trim()
        .to_owned();

    let (declaration_line, declaration_source) =
        cursor
            .next_nonblank()
            .ok_or_else(|| DefinitionSourceError::UnexpectedEnd {
                expected: "a phenix-workflow or phenix-router fenced declaration",
            })?;
    let kind = match declaration_source.trim() {
        "```phenix-workflow" => DefinitionSourceKind::Workflow,
        "```phenix-router" => DefinitionSourceKind::Router,
        found => {
            return Err(DefinitionSourceError::UnexpectedLine {
                line: declaration_line,
                expected: "```phenix-workflow or ```phenix-router",
                found: found.to_owned(),
            })
        }
    };
    let metadata = parse_metadata(&mut cursor, declaration_line, kind)?;
    let id = required_metadata(&metadata, declaration_line, "id")?;

    let (section_line, section_source) =
        cursor
            .next_nonblank()
            .ok_or_else(|| DefinitionSourceError::UnexpectedEnd {
                expected: match kind {
                    DefinitionSourceKind::Workflow => "the ## Steps section",
                    DefinitionSourceKind::Router => "the ## Routes section",
                },
            })?;
    let expected_section = match kind {
        DefinitionSourceKind::Workflow => "## Steps",
        DefinitionSourceKind::Router => "## Routes",
    };
    if section_source.trim() != expected_section {
        return Err(DefinitionSourceError::UnexpectedLine {
            line: section_line,
            expected: expected_section,
            found: section_source.to_owned(),
        });
    }

    match kind {
        DefinitionSourceKind::Workflow => parse_workflow(title, id, &mut cursor),
        DefinitionSourceKind::Router => parse_router(title, id, &mut cursor),
    }
}

fn parse_metadata(
    cursor: &mut SourceCursor<'_>,
    declaration_line: usize,
    kind: DefinitionSourceKind,
) -> Result<BTreeMap<String, String>, DefinitionSourceError> {
    let mut metadata = BTreeMap::new();
    loop {
        let Some((line, source)) = cursor.next() else {
            return Err(DefinitionSourceError::UnterminatedDeclaration {
                line: declaration_line,
            });
        };
        let trimmed = source.trim();
        if trimmed == "```" {
            break;
        }
        if trimmed.is_empty() {
            continue;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            return Err(DefinitionSourceError::InvalidMetadata {
                line,
                reason: "expected key: value".to_owned(),
            });
        };
        let key = key.trim();
        let value = value.trim();
        if key != "id" {
            return Err(DefinitionSourceError::UnknownField {
                line,
                declaration: kind,
                field: key.to_owned(),
            });
        }
        if value.is_empty() {
            return Err(DefinitionSourceError::InvalidMetadata {
                line,
                reason: format!("{key} must not be empty"),
            });
        }
        if metadata.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(DefinitionSourceError::DuplicateField {
                line,
                field: key.to_owned(),
            });
        }
    }
    Ok(metadata)
}

fn required_metadata<'a>(
    metadata: &'a BTreeMap<String, String>,
    declaration_line: usize,
    field: &'static str,
) -> Result<&'a str, DefinitionSourceError> {
    metadata
        .get(field)
        .map(String::as_str)
        .ok_or(DefinitionSourceError::MissingField {
            line: declaration_line,
            field,
        })
}

fn parse_workflow(
    title: String,
    id: &str,
    cursor: &mut SourceCursor<'_>,
) -> Result<ParsedDefinition, DefinitionSourceError> {
    let id = parse_id(id, None, "workflow id", WorkflowId::parse)?;
    let rows = parse_table(cursor, &["Key", "Parent", "Role", "Objective"])?;
    let mut seen = BTreeSet::new();
    let mut steps = Vec::with_capacity(rows.len());
    for row in rows {
        let key = cell(&row, 0);
        validate_symbol(key, row.line, "workflow step key")?;
        if !seen.insert(key.to_owned()) {
            return Err(DefinitionSourceError::InvalidTable {
                line: row.line,
                reason: format!("duplicate workflow step key {key}"),
            });
        }
        let parent = match cell(&row, 1) {
            "" | "-" => None,
            parent => {
                validate_symbol(parent, row.line, "workflow parent key")?;
                if !seen.contains(parent) {
                    return Err(DefinitionSourceError::InvalidTable {
                        line: row.line,
                        reason: format!(
                            "workflow step {key} refers to parent {parent} before it is defined"
                        ),
                    });
                }
                Some(parent.to_owned())
            }
        };
        let role_source = cell(&row, 2);
        let role = parse_id(role_source, Some(row.line), "role", RoleId::parse)?;
        let objective = cell(&row, 3);
        validate_objective_template(objective, row.line)?;
        steps.push(WorkflowStepDefinition {
            key: key.to_owned(),
            parent,
            role,
            objective: objective.to_owned(),
        });
    }
    if steps.is_empty() {
        return Err(DefinitionSourceError::InvalidTable {
            line: cursor.last_line(),
            reason: "workflow requires at least one step".to_owned(),
        });
    }
    Ok(ParsedDefinition::Workflow(WorkflowDefinition {
        id,
        title,
        steps,
    }))
}

fn parse_router(
    title: String,
    id: &str,
    cursor: &mut SourceCursor<'_>,
) -> Result<ParsedDefinition, DefinitionSourceError> {
    let id = parse_id(id, None, "router id", RouterId::parse)?;
    let rows = parse_table(cursor, &["Role", "Workflow", "Target", "Explanation"])?;
    let mut rules = Vec::with_capacity(rows.len());
    for row in rows {
        let rule = RoutingRule {
            role: parse_selector(cell(&row, 0), row.line, "role", RoleId::parse)?,
            workflow: parse_selector(cell(&row, 1), row.line, "workflow", WorkflowId::parse)?,
            target: ModelTarget::parse_at(cell(&row, 2), Some(row.line))?,
            explanation: required_cell(&row, 3, "explanation")?.to_owned(),
        };
        if let Some(shadowing) = rules
            .iter()
            .find(|existing: &&RoutingRule| existing.covers(&rule))
        {
            return Err(DefinitionSourceError::InvalidTable {
                line: row.line,
                reason: format!(
                    "route is unreachable because an earlier route to {} already covers it",
                    shadowing.target
                ),
            });
        }
        rules.push(rule);
    }
    if rules.is_empty() {
        return Err(DefinitionSourceError::InvalidTable {
            line: cursor.last_line(),
            reason: "router requires at least one route".to_owned(),
        });
    }
    let Some(last) = rules.last() else {
        unreachable!("non-empty routing rules were checked")
    };
    if !matches!(last.role, RouteSelector::Any) || !matches!(last.workflow, RouteSelector::Any) {
        return Err(DefinitionSourceError::InvalidTable {
            line: cursor.last_line(),
            reason: "the final route must be the */* catch-all".to_owned(),
        });
    }
    Ok(ParsedDefinition::Router(RoutingTable { id, title, rules }))
}

#[derive(Debug)]
struct TableRow {
    line: usize,
    cells: Vec<String>,
}

fn parse_table(
    cursor: &mut SourceCursor<'_>,
    expected_header: &[&str],
) -> Result<Vec<TableRow>, DefinitionSourceError> {
    let (header_line, header_source) =
        cursor
            .next_nonblank()
            .ok_or_else(|| DefinitionSourceError::UnexpectedEnd {
                expected: "a Markdown table header",
            })?;
    let header = parse_pipe_row(header_source, header_line)?;
    if header.iter().map(String::as_str).collect::<Vec<_>>() != expected_header {
        return Err(DefinitionSourceError::InvalidTable {
            line: header_line,
            reason: format!(
                "expected columns {}, found {}",
                expected_header.join(" | "),
                header.join(" | ")
            ),
        });
    }

    let (separator_line, separator_source) =
        cursor
            .next_nonblank()
            .ok_or_else(|| DefinitionSourceError::UnexpectedEnd {
                expected: "a Markdown table separator",
            })?;
    let separator = raw_pipe_row(separator_source, separator_line)?;
    if separator.len() != expected_header.len()
        || separator.iter().any(|cell| !valid_separator_cell(cell))
    {
        return Err(DefinitionSourceError::InvalidTable {
            line: separator_line,
            reason: "invalid Markdown table separator".to_owned(),
        });
    }

    let mut rows = Vec::new();
    while let Some((line, source)) = cursor.next_nonblank() {
        let cells = parse_pipe_row(source, line)?;
        if cells.len() != expected_header.len() {
            return Err(DefinitionSourceError::InvalidTable {
                line,
                reason: format!(
                    "expected {} cells, found {}",
                    expected_header.len(),
                    cells.len()
                ),
            });
        }
        rows.push(TableRow { line, cells });
    }
    Ok(rows)
}

fn parse_pipe_row(source: &str, line: usize) -> Result<Vec<String>, DefinitionSourceError> {
    raw_pipe_row(source, line)?
        .into_iter()
        .map(|cell| parse_cell(cell, line))
        .collect()
}

fn raw_pipe_row<'a>(source: &'a str, line: usize) -> Result<Vec<&'a str>, DefinitionSourceError> {
    let trimmed = source.trim();
    if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
        return Err(DefinitionSourceError::InvalidTable {
            line,
            reason: "table rows must start and end with |".to_owned(),
        });
    }
    Ok(trimmed[1..trimmed.len() - 1].split('|').collect())
}

fn parse_cell(source: &str, line: usize) -> Result<String, DefinitionSourceError> {
    let trimmed = source.trim();
    let starts = trimmed.starts_with('`');
    let ends = trimmed.ends_with('`');
    if starts != ends || (starts && trimmed.len() < 2) {
        return Err(DefinitionSourceError::InvalidTable {
            line,
            reason: format!("unbalanced inline code delimiter in cell {trimmed}"),
        });
    }
    Ok(if starts {
        trimmed[1..trimmed.len() - 1].trim().to_owned()
    } else {
        trimmed.to_owned()
    })
}

fn valid_separator_cell(source: &str) -> bool {
    let source = source.trim();
    let source = source.strip_prefix(':').unwrap_or(source);
    let source = source.strip_suffix(':').unwrap_or(source);
    source.len() >= 3 && source.chars().all(|character| character == '-')
}

fn cell(row: &TableRow, index: usize) -> &str {
    &row.cells[index]
}

fn required_cell<'a>(
    row: &'a TableRow,
    index: usize,
    name: &'static str,
) -> Result<&'a str, DefinitionSourceError> {
    let value = cell(row, index);
    if value.is_empty() {
        return Err(DefinitionSourceError::InvalidTable {
            line: row.line,
            reason: format!("{name} must not be empty"),
        });
    }
    Ok(value)
}

fn parse_selector<T>(
    value: &str,
    line: usize,
    field: &'static str,
    parser: impl FnOnce(String) -> Result<T, IdError>,
) -> Result<RouteSelector<T>, DefinitionSourceError> {
    if value == "*" {
        Ok(RouteSelector::Any)
    } else {
        Ok(RouteSelector::Exact(parse_id(
            value,
            Some(line),
            field,
            parser,
        )?))
    }
}

fn parse_id<T>(
    value: &str,
    line: Option<usize>,
    field: &'static str,
    parser: impl FnOnce(String) -> Result<T, IdError>,
) -> Result<T, DefinitionSourceError> {
    parser(value.to_owned()).map_err(|error| DefinitionSourceError::InvalidValue {
        line,
        field,
        value: value.to_owned(),
        reason: error.to_string(),
    })
}

fn validate_symbol(
    value: &str,
    line: usize,
    field: &'static str,
) -> Result<(), DefinitionSourceError> {
    if value.is_empty()
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(DefinitionSourceError::InvalidValue {
            line: Some(line),
            field,
            value: value.to_owned(),
            reason: "expected ASCII letters, digits, '.', '_', or '-'".to_owned(),
        });
    }
    Ok(())
}

fn validate_objective_template(value: &str, line: usize) -> Result<(), DefinitionSourceError> {
    if value.is_empty() {
        return Err(DefinitionSourceError::InvalidTable {
            line,
            reason: "workflow objective must not be empty".to_owned(),
        });
    }
    if !value.contains(OBJECTIVE_PLACEHOLDER) {
        return Err(DefinitionSourceError::InvalidTable {
            line,
            reason: format!(
                "workflow objective must contain the literal {OBJECTIVE_PLACEHOLDER} placeholder"
            ),
        });
    }
    let without_objective = value.replace(OBJECTIVE_PLACEHOLDER, "");
    if without_objective.contains('{') || without_objective.contains('}') {
        return Err(DefinitionSourceError::InvalidTable {
            line,
            reason: "{objective} is the only supported workflow placeholder".to_owned(),
        });
    }
    Ok(())
}

struct SourceCursor<'a> {
    lines: Vec<&'a str>,
    index: usize,
}

impl<'a> SourceCursor<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            lines: source.lines().collect(),
            index: 0,
        }
    }

    fn next(&mut self) -> Option<(usize, &'a str)> {
        let source = *self.lines.get(self.index)?;
        self.index += 1;
        Some((self.index, source))
    }

    fn next_nonblank(&mut self) -> Option<(usize, &'a str)> {
        loop {
            let next = self.next()?;
            if !next.1.trim().is_empty() {
                return Some(next);
            }
        }
    }

    fn last_line(&self) -> usize {
        self.index.max(1)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DefinitionSourceError {
    EmptyDocument,
    InvalidControlCharacter,
    UnexpectedEnd {
        expected: &'static str,
    },
    UnexpectedLine {
        line: usize,
        expected: &'static str,
        found: String,
    },
    UnterminatedDeclaration {
        line: usize,
    },
    InvalidMetadata {
        line: usize,
        reason: String,
    },
    MissingField {
        line: usize,
        field: &'static str,
    },
    UnknownField {
        line: usize,
        declaration: DefinitionSourceKind,
        field: String,
    },
    DuplicateField {
        line: usize,
        field: String,
    },
    InvalidValue {
        line: Option<usize>,
        field: &'static str,
        value: String,
        reason: String,
    },
    InvalidTable {
        line: usize,
        reason: String,
    },
    UnexpectedKind {
        expected: DefinitionSourceKind,
        actual: DefinitionSourceKind,
    },
    DuplicateDefinition {
        kind: DefinitionSourceKind,
        id: String,
    },
    Gateway(GatewayError),
}

impl Display for DefinitionSourceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyDocument => formatter.write_str("definition source is empty"),
            Self::InvalidControlCharacter => {
                formatter.write_str("definition source contains an invalid control character")
            }
            Self::UnexpectedEnd { expected } => {
                write!(formatter, "definition source ended before {expected}")
            }
            Self::UnexpectedLine {
                line,
                expected,
                found,
            } => write!(
                formatter,
                "definition source line {line}: expected {expected}, found {found:?}"
            ),
            Self::UnterminatedDeclaration { line } => write!(
                formatter,
                "definition source declaration opened on line {line} is not terminated"
            ),
            Self::InvalidMetadata { line, reason } => {
                write!(formatter, "definition source line {line}: {reason}")
            }
            Self::MissingField { line, field } => write!(
                formatter,
                "definition source declaration on line {line} is missing {field}"
            ),
            Self::UnknownField {
                line,
                declaration,
                field,
            } => write!(
                formatter,
                "definition source line {line}: unknown {declaration} field {field}"
            ),
            Self::DuplicateField { line, field } => write!(
                formatter,
                "definition source line {line}: duplicate field {field}"
            ),
            Self::InvalidValue {
                line,
                field,
                value,
                reason,
            } => {
                if let Some(line) = line {
                    write!(
                        formatter,
                        "definition source line {line}: invalid {field} {value:?}: {reason}"
                    )
                } else {
                    write!(formatter, "invalid {field} {value:?}: {reason}")
                }
            }
            Self::InvalidTable { line, reason } => {
                write!(formatter, "definition source table line {line}: {reason}")
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
            Self::Gateway(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for DefinitionSourceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Gateway(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SessionTreeId, WorkflowRequest};

    const WORKFLOW: &str = r#"# Implementation

```phenix-workflow
id: phenix.implement
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `implement` | | `implementer` | Implement {objective} |
| `verify` | `implement` | `verifier` | Verify {objective} |
"#;

    const ROUTER: &str = r#"# Default routing

```phenix-router
id: phenix.capability-budget
```

## Routes

| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `verifier` | `phenix.implement` | `pi/anthropic/sonnet` | Strong verification route |
| `*` | `*` | `pi/openai/gpt-5.6-sol` | Default route |
"#;

    #[test]
    fn arbitrary_text_is_not_a_definition() {
        assert!(matches!(
            parse_definition("hello"),
            Err(DefinitionSourceError::UnexpectedLine { line: 1, .. })
        ));
    }

    #[test]
    fn one_parser_detects_workflows_and_routers() {
        assert!(matches!(
            parse_definition(WORKFLOW).expect("workflow"),
            ParsedDefinition::Workflow(_)
        ));
        assert!(matches!(
            parse_definition(ROUTER).expect("router"),
            ParsedDefinition::Router(_)
        ));
    }

    #[test]
    fn workflow_source_compiles_to_a_typed_plan() {
        let ParsedDefinition::Workflow(workflow) = parse_definition(WORKFLOW).expect("workflow")
        else {
            panic!("workflow definition expected")
        };
        let plan = workflow
            .plan(&WorkflowRequest {
                tree_id: SessionTreeId::parse("tree-test").expect("tree"),
                objective: "ship the feature".to_owned(),
            })
            .expect("plan");
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[1].parent.as_deref(), Some("implement"));
        assert_eq!(plan.steps[0].objective, "Implement ship the feature");
    }

    #[test]
    fn router_source_selects_a_backend_qualified_model() {
        let ParsedDefinition::Router(router) = parse_definition(ROUTER).expect("router") else {
            panic!("router definition expected")
        };
        let decision = router
            .route(&RoutingRequest {
                tree_id: SessionTreeId::parse("tree-test").expect("tree"),
                parent_node: None,
                role: RoleId::parse("verifier").expect("role"),
                objective: "verify".to_owned(),
                workflow: Some(WorkflowId::parse("phenix.implement").expect("workflow")),
                available_backends: vec![BackendId::parse("pi").expect("backend")],
            })
            .expect("route");
        assert_eq!(decision.backend.as_str(), "pi");
        let model = decision.model.expect("model");
        assert_eq!(model.provider.as_str(), "anthropic");
        assert_eq!(model.model.as_str(), "sonnet");
    }

    #[test]
    fn invalid_markdown_subset_is_rejected() {
        let malformed = WORKFLOW.replace("## Steps", "### Steps");
        assert!(matches!(
            parse_definition(&malformed),
            Err(DefinitionSourceError::UnexpectedLine { .. })
        ));

        let malformed = WORKFLOW.replace("|---|---|---|---|", "not a separator");
        assert!(matches!(
            parse_definition(&malformed),
            Err(DefinitionSourceError::InvalidTable { .. })
        ));
    }

    #[test]
    fn workflow_requires_topological_steps_and_objective_transport() {
        let child_first = WORKFLOW.replace(
            "| `implement` | | `implementer` | Implement {objective} |\n| `verify` | `implement` | `verifier` | Verify {objective} |",
            "| `verify` | `implement` | `verifier` | Verify {objective} |",
        );
        assert!(matches!(
            parse_definition(&child_first),
            Err(DefinitionSourceError::InvalidTable { .. })
        ));

        let no_objective = WORKFLOW.replace("Implement {objective}", "Implement the task");
        assert!(matches!(
            parse_definition(&no_objective),
            Err(DefinitionSourceError::InvalidTable { .. })
        ));
    }

    #[test]
    fn router_rejects_shadowed_rows_and_requires_a_final_catch_all() {
        let shadowed = ROUTER.replace(
            "| `verifier` | `phenix.implement` | `pi/anthropic/sonnet` | Strong verification route |\n| `*` | `*` | `pi/openai/gpt-5.6-sol` | Default route |",
            "| `*` | `*` | `pi/openai/gpt-5.6-sol` | Default route |\n| `verifier` | `phenix.implement` | `pi/anthropic/sonnet` | Unreachable |",
        );
        assert!(matches!(
            parse_definition(&shadowed),
            Err(DefinitionSourceError::InvalidTable { .. })
        ));

        let no_catch_all = ROUTER.replace(
            "| `*` | `*` | `pi/openai/gpt-5.6-sol` | Default route |",
            "| `stock` | `*` | `pi/openai/gpt-5.6-sol` | Stock route |",
        );
        assert!(matches!(
            parse_definition(&no_catch_all),
            Err(DefinitionSourceError::InvalidTable { .. })
        ));
    }

    #[test]
    fn source_collection_rejects_duplicate_ids_and_wrong_kinds() {
        let mut sources = DefinitionSources::new();
        sources.add_workflow(WORKFLOW).expect("workflow");
        assert!(matches!(
            sources.add_workflow(WORKFLOW),
            Err(DefinitionSourceError::DuplicateDefinition { .. })
        ));
        assert!(matches!(
            sources.add_workflow(ROUTER),
            Err(DefinitionSourceError::UnexpectedKind { .. })
        ));
    }
}
