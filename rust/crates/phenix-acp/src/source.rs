use crate::{
    BackendId, Difficulty, GatewayError, IdError, ModelConfig, ModelId, ProviderId, RoleId,
    RouterId, RoutingDecision, RoutingRequest, SessionRouter, ThinkingLevel, Workflow,
    WorkflowCondition, WorkflowGraph, WorkflowGraphState, WorkflowId, WorkflowJoin,
    WorkflowOutcomeStatus, WorkflowPlan, WorkflowRequest, WorkflowStateKind, WorkflowTransition,
};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

const OBJECTIVE_PLACEHOLDER: &str = "{objective}";
const STATIC_WORKFLOW_HEADER: [&str; 4] = ["Key", "Parent", "Role", "Objective"];
const GRAPH_WORKFLOW_HEADER: [&str; 7] = [
    "Key",
    "Kind",
    "Role",
    "Required",
    "Join",
    "Objective",
    "Next",
];
const ROUTER_HEADER: [&str; 8] = [
    "Role",
    "Workflow",
    "D0",
    "D1",
    "D2",
    "D3",
    "D4",
    "Explanation",
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DefinitionSourceKind {
    Workflow,
    Router,
}

impl Display for DefinitionSourceKind {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Workflow => "workflow",
            Self::Router => "router",
        })
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
    graph: Option<WorkflowGraph>,
}

impl WorkflowDefinition {
    pub fn id(&self) -> &WorkflowId {
        &self.id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    /// Invoke-state projection retained for catalog/introspection compatibility.
    pub fn steps(&self) -> &[WorkflowStepDefinition] {
        &self.steps
    }

    pub fn policy_graph(&self) -> Option<&WorkflowGraph> {
        self.graph.as_ref()
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

    fn graph(&self) -> Option<WorkflowGraph> {
        self.graph.clone()
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
pub struct DifficultyModelConfigs {
    models: [ModelConfig; 5],
}

impl DifficultyModelConfigs {
    pub fn new(models: [ModelConfig; 5]) -> Self {
        Self { models }
    }

    pub fn get(&self, difficulty: Difficulty) -> &ModelConfig {
        &self.models[difficulty.index()]
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = (Difficulty, &ModelConfig)> {
        Difficulty::ALL.into_iter().zip(self.models.iter())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoutingRule {
    role: RouteSelector<RoleId>,
    workflow: RouteSelector<WorkflowId>,
    models: DifficultyModelConfigs,
    explanation: String,
}

impl RoutingRule {
    pub fn role(&self) -> &RouteSelector<RoleId> {
        &self.role
    }

    pub fn workflow(&self) -> &RouteSelector<WorkflowId> {
        &self.workflow
    }

    pub fn models(&self) -> &DifficultyModelConfigs {
        &self.models
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
        let rule = self.rules.iter().find(|rule| rule.matches(request)).ok_or_else(|| {
            GatewayError::routing(format!(
                "router {} has no matching route for role {}, workflow {}, difficulty {}",
                self.id,
                request.role,
                request
                    .workflow
                    .as_ref()
                    .map_or("<none>", WorkflowId::as_str),
                request.difficulty
            ))
        })?;
        let model = rule.models.get(request.difficulty).clone();
        if !request
            .available_backends
            .iter()
            .any(|backend| backend == &model.backend)
        {
            return Err(GatewayError::routing(format!(
                "router {} selected backend {} for {} which is not available in tree {}",
                self.id, model.backend, request.difficulty, request.tree_id
            )));
        }
        Ok(RoutingDecision {
            difficulty: request.difficulty,
            model,
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

    let (declaration_line, declaration_source) = cursor
        .next_nonblank()
        .ok_or(DefinitionSourceError::UnexpectedEnd {
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
            });
        }
    };
    let metadata = parse_metadata(&mut cursor, declaration_line, kind)?;
    let id = required_metadata(&metadata, declaration_line, "id")?;

    let (section_line, section_source) = cursor
        .next_nonblank()
        .ok_or(DefinitionSourceError::UnexpectedEnd {
            expected: match kind {
                DefinitionSourceKind::Workflow => "the ## Steps or ## States section",
                DefinitionSourceKind::Router => "the ## Routes section",
            },
        })?;

    match kind {
        DefinitionSourceKind::Workflow => match section_source.trim() {
            "## Steps" => parse_static_workflow(title, id, &mut cursor),
            "## States" => parse_graph_workflow(
                title,
                id,
                metadata.get("entry").map(String::as_str),
                section_line,
                &mut cursor,
            ),
            found => Err(DefinitionSourceError::UnexpectedLine {
                line: section_line,
                expected: "## Steps or ## States",
                found: found.to_owned(),
            }),
        },
        DefinitionSourceKind::Router => {
            if section_source.trim() != "## Routes" {
                return Err(DefinitionSourceError::UnexpectedLine {
                    line: section_line,
                    expected: "## Routes",
                    found: section_source.to_owned(),
                });
            }
            parse_router(title, id, &mut cursor)
        }
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
        let allowed = key == "id" || (kind == DefinitionSourceKind::Workflow && key == "entry");
        if !allowed {
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

fn parse_static_workflow(
    title: String,
    id: &str,
    cursor: &mut SourceCursor<'_>,
) -> Result<ParsedDefinition, DefinitionSourceError> {
    let id = parse_id(id, None, "workflow id", WorkflowId::parse)?;
    let rows = parse_table(cursor, &STATIC_WORKFLOW_HEADER)?;
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
        let role = parse_id(cell(&row, 2), Some(row.line), "role", RoleId::parse)?;
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
        graph: None,
    }))
}

fn parse_graph_workflow(
    title: String,
    id: &str,
    configured_entry: Option<&str>,
    section_line: usize,
    cursor: &mut SourceCursor<'_>,
) -> Result<ParsedDefinition, DefinitionSourceError> {
    let id = parse_id(id, None, "workflow id", WorkflowId::parse)?;
    let rows = parse_table(cursor, &GRAPH_WORKFLOW_HEADER)?;
    if rows.is_empty() {
        return Err(DefinitionSourceError::InvalidTable {
            line: section_line,
            reason: "workflow policy graph requires at least one state".to_owned(),
        });
    }

    let entry = configured_entry.unwrap_or_else(|| cell(&rows[0], 0));
    validate_symbol(entry, section_line, "workflow entry state")?;
    let mut graph_states = Vec::with_capacity(rows.len());
    let mut transitions = Vec::new();
    let mut steps = Vec::new();
    let mut seen = BTreeSet::new();

    for row in &rows {
        let key = required_cell(row, 0, "state key")?;
        validate_symbol(key, row.line, "workflow state key")?;
        if !seen.insert(key.to_owned()) {
            return Err(DefinitionSourceError::InvalidTable {
                line: row.line,
                reason: format!("duplicate workflow state key {key}"),
            });
        }
        let required = parse_required(cell(row, 3), row.line)?;
        let join = parse_join(cell(row, 4), row.line)?;
        let objective = cell(row, 5);
        let kind = match cell(row, 1) {
            "invoke" => {
                let role = parse_id(required_cell(row, 2, "invoke role")?, Some(row.line), "role", RoleId::parse)?;
                validate_objective_template(objective, row.line)?;
                steps.push(WorkflowStepDefinition {
                    key: key.to_owned(),
                    parent: None,
                    role: role.clone(),
                    objective: objective.to_owned(),
                });
                WorkflowStateKind::Invoke {
                    role,
                    objective: objective.to_owned(),
                }
            }
            "decision" => {
                require_virtual_role_empty(row)?;
                WorkflowStateKind::Decision
            }
            "return" => {
                require_virtual_role_empty(row)?;
                validate_terminal_text(objective, row.line, "return summary")?;
                WorkflowStateKind::Return {
                    summary: objective.to_owned(),
                }
            }
            "fail" => {
                require_virtual_role_empty(row)?;
                validate_terminal_text(objective, row.line, "failure reason")?;
                WorkflowStateKind::Fail {
                    reason: objective.to_owned(),
                }
            }
            value => {
                return Err(DefinitionSourceError::InvalidValue {
                    line: Some(row.line),
                    field: "state kind",
                    value: value.to_owned(),
                    reason: "expected invoke, decision, return, or fail".to_owned(),
                });
            }
        };
        graph_states.push(WorkflowGraphState {
            key: key.to_owned(),
            join,
            required,
            kind,
        });
        transitions.extend(parse_transitions(key, cell(row, 6), row.line)?);
    }

    let graph = WorkflowGraph {
        entry: entry.to_owned(),
        states: graph_states,
        transitions,
    };
    graph.validate().map_err(|error| DefinitionSourceError::InvalidTable {
        line: section_line,
        reason: error.to_string(),
    })?;
    if steps.is_empty() {
        return Err(DefinitionSourceError::InvalidTable {
            line: section_line,
            reason: "workflow policy graph requires at least one invoke state".to_owned(),
        });
    }
    Ok(ParsedDefinition::Workflow(WorkflowDefinition {
        id,
        title,
        steps,
        graph: Some(graph),
    }))
}

fn parse_required(value: &str, line: usize) -> Result<bool, DefinitionSourceError> {
    match value {
        "required" | "true" | "yes" => Ok(true),
        "optional" | "false" | "no" | "" | "-" => Ok(false),
        value => Err(DefinitionSourceError::InvalidValue {
            line: Some(line),
            field: "required",
            value: value.to_owned(),
            reason: "expected required/optional or true/false".to_owned(),
        }),
    }
}

fn parse_join(value: &str, line: usize) -> Result<WorkflowJoin, DefinitionSourceError> {
    match value {
        "" | "-" | "any" => Ok(WorkflowJoin::Any),
        "all-settled" | "all_settled" => Ok(WorkflowJoin::AllSettled),
        value => Err(DefinitionSourceError::InvalidValue {
            line: Some(line),
            field: "join",
            value: value.to_owned(),
            reason: "expected any or all-settled".to_owned(),
        }),
    }
}

fn require_virtual_role_empty(row: &TableRow) -> Result<(), DefinitionSourceError> {
    if matches!(cell(row, 2), "" | "-") {
        Ok(())
    } else {
        Err(DefinitionSourceError::InvalidTable {
            line: row.line,
            reason: "decision/return/fail states must not declare a role".to_owned(),
        })
    }
}

fn validate_terminal_text(
    value: &str,
    line: usize,
    field: &'static str,
) -> Result<(), DefinitionSourceError> {
    if value.trim().is_empty() {
        return Err(DefinitionSourceError::InvalidValue {
            line: Some(line),
            field,
            value: value.to_owned(),
            reason: "must not be empty".to_owned(),
        });
    }
    let without_objective = value.replace(OBJECTIVE_PLACEHOLDER, "");
    if without_objective.contains('{') || without_objective.contains('}') {
        return Err(DefinitionSourceError::InvalidValue {
            line: Some(line),
            field,
            value: value.to_owned(),
            reason: "{objective} is the only supported template placeholder".to_owned(),
        });
    }
    Ok(())
}

fn parse_transitions(
    from: &str,
    source: &str,
    line: usize,
) -> Result<Vec<WorkflowTransition>, DefinitionSourceError> {
    if source.trim().is_empty() || source == "-" {
        return Ok(Vec::new());
    }
    source
        .split(';')
        .map(str::trim)
        .filter(|transition| !transition.is_empty())
        .map(|transition| {
            let (to, when) = match transition.split_once(" if ") {
                Some((to, condition)) => (to.trim(), parse_condition(condition.trim(), line)?),
                None => (transition, WorkflowCondition::Always),
            };
            validate_symbol(to, line, "workflow transition target")?;
            Ok(WorkflowTransition {
                from: from.to_owned(),
                to: to.to_owned(),
                when,
            })
        })
        .collect()
}

fn parse_condition(source: &str, line: usize) -> Result<WorkflowCondition, DefinitionSourceError> {
    if let Some(path) = source.strip_prefix("input.").and_then(|rest| rest.strip_suffix(" exists")) {
        return Ok(WorkflowCondition::InputExists {
            path: path.trim().to_owned(),
        });
    }
    if let Some(path) = source.strip_prefix("input.").and_then(|rest| rest.strip_suffix(" missing")) {
        return Ok(WorkflowCondition::InputMissing {
            path: path.trim().to_owned(),
        });
    }
    if let Some(rest) = source.strip_prefix("output.") {
        if let Some((path, value)) = rest.split_once(" contains ") {
            return Ok(WorkflowCondition::OutputContains {
                path: path.trim().to_owned(),
                value: value.trim().to_owned(),
            });
        }
        if let Some((path, value)) = rest.split_once(" = ") {
            return Ok(WorkflowCondition::OutputEquals {
                path: path.trim().to_owned(),
                value: value.trim().to_owned(),
            });
        }
    }
    if let Some(value) = source.strip_prefix("outcome = ") {
        let status = match value.trim() {
            "success" => WorkflowOutcomeStatus::Success,
            "failure" => WorkflowOutcomeStatus::Failure,
            "cancelled" => WorkflowOutcomeStatus::Cancelled,
            "skipped" => WorkflowOutcomeStatus::Skipped,
            other => {
                return Err(DefinitionSourceError::InvalidValue {
                    line: Some(line),
                    field: "transition condition",
                    value: other.to_owned(),
                    reason: "outcome must be success, failure, cancelled, or skipped".to_owned(),
                });
            }
        };
        return Ok(WorkflowCondition::Outcome { status });
    }
    Err(DefinitionSourceError::InvalidValue {
        line: Some(line),
        field: "transition condition",
        value: source.to_owned(),
        reason: "expected input.<path> exists/missing, output.<path> = <value>, output.<path> contains <value>, or outcome = <status>".to_owned(),
    })
}

fn parse_router(
    title: String,
    id: &str,
    cursor: &mut SourceCursor<'_>,
) -> Result<ParsedDefinition, DefinitionSourceError> {
    let id = parse_id(id, None, "router id", RouterId::parse)?;
    let rows = parse_table(cursor, &ROUTER_HEADER)?;
    let mut rules = Vec::with_capacity(rows.len());
    for row in rows {
        let models = DifficultyModelConfigs::new([
            parse_model_config(cell(&row, 2), row.line, "d0")?,
            parse_model_config(cell(&row, 3), row.line, "d1")?,
            parse_model_config(cell(&row, 4), row.line, "d2")?,
            parse_model_config(cell(&row, 5), row.line, "d3")?,
            parse_model_config(cell(&row, 6), row.line, "d4")?,
        ]);
        let rule = RoutingRule {
            role: parse_selector(cell(&row, 0), row.line, "role", RoleId::parse)?,
            workflow: parse_selector(cell(&row, 1), row.line, "workflow", WorkflowId::parse)?,
            models,
            explanation: required_cell(&row, 7, "explanation")?.to_owned(),
        };
        if rules
            .iter()
            .any(|existing: &RoutingRule| existing.covers(&rule))
        {
            return Err(DefinitionSourceError::InvalidTable {
                line: row.line,
                reason: "route is unreachable because an earlier route already covers it".to_owned(),
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
    let last = rules.last().expect("non-empty routing rules were checked");
    if !matches!(last.role, RouteSelector::Any) || !matches!(last.workflow, RouteSelector::Any) {
        return Err(DefinitionSourceError::InvalidTable {
            line: cursor.last_line(),
            reason: "the final route must be the */* catch-all".to_owned(),
        });
    }
    Ok(ParsedDefinition::Router(RoutingTable { id, title, rules }))
}

fn parse_model_config(
    value: &str,
    line: usize,
    field: &'static str,
) -> Result<ModelConfig, DefinitionSourceError> {
    let parts = value.split('/').collect::<Vec<_>>();
    if parts.len() != 4 || parts.iter().any(|part| part.is_empty()) {
        return Err(DefinitionSourceError::InvalidValue {
            line: Some(line),
            field,
            value: value.to_owned(),
            reason: "expected backend/provider/model/thinking".to_owned(),
        });
    }
    Ok(ModelConfig {
        backend: parse_id(parts[0], Some(line), "backend", BackendId::parse)?,
        provider: parse_id(parts[1], Some(line), "provider", ProviderId::parse)?,
        model: parse_id(parts[2], Some(line), "model", ModelId::parse)?,
        thinking: parse_thinking(parts[3], line, field)?,
    })
}

fn parse_thinking(
    value: &str,
    line: usize,
    field: &'static str,
) -> Result<ThinkingLevel, DefinitionSourceError> {
    match value {
        "off" => Ok(ThinkingLevel::Off),
        "minimal" => Ok(ThinkingLevel::Minimal),
        "low" => Ok(ThinkingLevel::Low),
        "medium" => Ok(ThinkingLevel::Medium),
        "high" => Ok(ThinkingLevel::High),
        "extra_high" | "extra-high" => Ok(ThinkingLevel::ExtraHigh),
        "max" => Ok(ThinkingLevel::Max),
        _ => Err(DefinitionSourceError::InvalidValue {
            line: Some(line),
            field,
            value: value.to_owned(),
            reason: "expected off, minimal, low, medium, high, extra_high, or max".to_owned(),
        }),
    }
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
    let (header_line, header_source) = cursor
        .next_nonblank()
        .ok_or(DefinitionSourceError::UnexpectedEnd {
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

    let (separator_line, separator_source) = cursor
        .next_nonblank()
        .ok_or(DefinitionSourceError::UnexpectedEnd {
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

fn raw_pipe_row(source: &str, line: usize) -> Result<Vec<&str>, DefinitionSourceError> {
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
        }
    }
}

impl Error for DefinitionSourceError {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SessionTreeId;

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

    const GRAPH_WORKFLOW: &str = r#"# Managed implementation

```phenix-workflow
id: phenix.managed
entry: route-plan
```

## States

| Key | Kind | Role | Required | Join | Objective | Next |
|---|---|---|---|---|---|---|
| `route-plan` | `decision` | | `optional` | `any` | | `plan if input.plan missing; implement if input.plan exists` |
| `plan` | `invoke` | `planner` | `required` | `any` | Plan {objective} | `implement` |
| `implement` | `invoke` | `implementer` | `required` | `any` | Implement {objective} | `return` |
| `return` | `return` | | `optional` | `any` | Implemented {objective} | |
"#;

    const ROUTER: &str = r#"# Default routing

```phenix-router
id: phenix.capability-budget
```

## Routes

| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
|---|---|---|---|---|---|---|---|
| `verifier` | `phenix.implement` | `pi/anthropic/sonnet/low` | `pi/anthropic/sonnet/medium` | `pi/anthropic/sonnet/high` | `pi/anthropic/opus/high` | `pi/anthropic/opus/max` | Strong verification route |
| `*` | `*` | `pi/openai/gpt-5.6-luna/minimal` | `pi/openai/gpt-5.6-luna/low` | `pi/openai/gpt-5.6-sol/medium` | `pi/openai/gpt-5.6-sol/high` | `pi/openai/gpt-5.6-sol/max` | Default route |
"#;

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
    fn static_workflow_source_compiles_to_a_typed_plan() {
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
    fn graph_workflow_source_preserves_explicit_policy() {
        let ParsedDefinition::Workflow(workflow) =
            parse_definition(GRAPH_WORKFLOW).expect("graph workflow")
        else {
            panic!("workflow definition expected")
        };
        let graph = workflow.policy_graph().expect("policy graph");
        assert_eq!(graph.entry, "route-plan");
        assert_eq!(workflow.steps().len(), 2);
        assert!(graph.transitions.iter().any(|transition| matches!(
            transition.when,
            WorkflowCondition::InputExists { ref path } if path == "plan"
        )));
    }

    #[test]
    fn router_selects_the_full_model_config_for_difficulty() {
        let ParsedDefinition::Router(router) = parse_definition(ROUTER).expect("router") else {
            panic!("router definition expected")
        };
        let decision = router
            .route(&RoutingRequest {
                tree_id: SessionTreeId::parse("tree-test").expect("tree"),
                parent_node: None,
                role: RoleId::parse("verifier").expect("role"),
                difficulty: Difficulty::D3,
                objective: "verify".to_owned(),
                workflow: Some(WorkflowId::parse("phenix.implement").expect("workflow")),
                available_backends: vec![BackendId::parse("pi").expect("backend")],
            })
            .expect("route");
        assert_eq!(decision.difficulty, Difficulty::D3);
        assert_eq!(decision.model.backend.as_str(), "pi");
        assert_eq!(decision.model.provider.as_str(), "anthropic");
        assert_eq!(decision.model.model.as_str(), "opus");
        assert_eq!(decision.model.thinking, ThinkingLevel::High);
    }

    #[test]
    fn router_requires_all_five_difficulty_columns() {
        let malformed = ROUTER.replace(" | D4 |", " |");
        assert!(matches!(
            parse_definition(&malformed),
            Err(DefinitionSourceError::InvalidTable { .. })
        ));
    }
}
