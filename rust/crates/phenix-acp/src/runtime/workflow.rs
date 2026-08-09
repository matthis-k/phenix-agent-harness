use crate::{GatewayError, RoleId, SessionEvent, SessionNodeId};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const OBJECTIVE_PLACEHOLDER: &str = "{objective}";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowGraph {
    pub entry: String,
    pub states: Vec<WorkflowGraphState>,
    pub transitions: Vec<WorkflowTransition>,
}

impl WorkflowGraph {
    pub fn validate(&self) -> Result<(), GatewayError> {
        if self.states.is_empty() {
            return Err(GatewayError::InvalidWorkflowPlan(
                "workflow graph must contain at least one state".to_owned(),
            ));
        }
        let mut keys = BTreeSet::new();
        for state in &self.states {
            validate_key(&state.key)?;
            if !keys.insert(state.key.clone()) {
                return Err(GatewayError::InvalidWorkflowPlan(format!(
                    "duplicate workflow state {}",
                    state.key
                )));
            }
            match &state.kind {
                WorkflowStateKind::Invoke { objective, .. } if objective.trim().is_empty() => {
                    return Err(GatewayError::InvalidWorkflowPlan(format!(
                        "workflow invoke state {} has an empty objective",
                        state.key
                    )));
                }
                WorkflowStateKind::Invoke { .. }
                | WorkflowStateKind::Decision
                | WorkflowStateKind::Return { .. }
                | WorkflowStateKind::Fail { .. } => {}
            }
        }
        if !keys.contains(&self.entry) {
            return Err(GatewayError::InvalidWorkflowPlan(format!(
                "workflow entry state {} does not exist",
                self.entry
            )));
        }

        let mut outgoing = BTreeMap::<&str, usize>::new();
        let mut adjacency = BTreeMap::<&str, Vec<&str>>::new();
        for transition in &self.transitions {
            if !keys.contains(&transition.from) {
                return Err(GatewayError::InvalidWorkflowPlan(format!(
                    "workflow transition source {} does not exist",
                    transition.from
                )));
            }
            if !keys.contains(&transition.to) {
                return Err(GatewayError::InvalidWorkflowPlan(format!(
                    "workflow transition target {} does not exist",
                    transition.to
                )));
            }
            *outgoing.entry(&transition.from).or_default() += 1;
            adjacency
                .entry(&transition.from)
                .or_default()
                .push(&transition.to);
        }
        for state in &self.states {
            match state.kind {
                WorkflowStateKind::Return { .. } | WorkflowStateKind::Fail { .. } => {
                    if outgoing
                        .get(state.key.as_str())
                        .copied()
                        .unwrap_or_default()
                        != 0
                    {
                        return Err(GatewayError::InvalidWorkflowPlan(format!(
                            "terminal workflow state {} must not have outgoing transitions",
                            state.key
                        )));
                    }
                }
                WorkflowStateKind::Invoke { .. } | WorkflowStateKind::Decision => {
                    if outgoing
                        .get(state.key.as_str())
                        .copied()
                        .unwrap_or_default()
                        == 0
                    {
                        return Err(GatewayError::InvalidWorkflowPlan(format!(
                            "workflow state {} has no outgoing transition",
                            state.key
                        )));
                    }
                }
            }
        }
        reject_cycles(&self.entry, &adjacency)?;

        let mut reachable = BTreeSet::new();
        collect_reachable(&self.entry, &adjacency, &mut reachable);
        if let Some(unreachable) = self
            .states
            .iter()
            .find(|state| !reachable.contains(state.key.as_str()))
        {
            return Err(GatewayError::InvalidWorkflowPlan(format!(
                "workflow state {} is unreachable from entry {}",
                unreachable.key, self.entry
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowGraphState {
    pub key: String,
    #[serde(default)]
    pub join: WorkflowJoin,
    #[serde(default)]
    pub required: bool,
    pub kind: WorkflowStateKind,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowJoin {
    #[default]
    Any,
    AllSettled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkflowStateKind {
    Invoke { role: RoleId, objective: String },
    Decision,
    Return { summary: String },
    Fail { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowTransition {
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub when: WorkflowCondition,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkflowCondition {
    #[default]
    Always,
    InputExists {
        path: String,
    },
    InputMissing {
        path: String,
    },
    OutputEquals {
        path: String,
        value: String,
    },
    OutputContains {
        path: String,
        value: String,
    },
    Outcome {
        status: WorkflowOutcomeStatus,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowOutcomeStatus {
    Success,
    Failure,
    Cancelled,
    Skipped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkflowAction {
    Invoke {
        key: String,
        role: RoleId,
        objective: String,
        required: bool,
        context: Value,
    },
    Complete(WorkflowTerminal),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkflowTerminal {
    pub success: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum StateStatus {
    Pending,
    Starting,
    Running {
        node_id: SessionNodeId,
        text: String,
    },
    Succeeded {
        node_id: Option<SessionNodeId>,
        output: Value,
    },
    Failed {
        node_id: Option<SessionNodeId>,
        message: String,
    },
    Cancelled {
        node_id: Option<SessionNodeId>,
    },
    Skipped,
    Terminal,
}

impl StateStatus {
    fn settled(&self) -> bool {
        matches!(
            self,
            Self::Succeeded { .. }
                | Self::Failed { .. }
                | Self::Cancelled { .. }
                | Self::Skipped
                | Self::Terminal
        )
    }

    fn outcome(&self) -> Option<WorkflowOutcomeStatus> {
        match self {
            Self::Succeeded { .. } | Self::Terminal => Some(WorkflowOutcomeStatus::Success),
            Self::Failed { .. } => Some(WorkflowOutcomeStatus::Failure),
            Self::Cancelled { .. } => Some(WorkflowOutcomeStatus::Cancelled),
            Self::Skipped => Some(WorkflowOutcomeStatus::Skipped),
            Self::Pending | Self::Starting | Self::Running { .. } => None,
        }
    }

    fn output(&self) -> Option<&Value> {
        match self {
            Self::Succeeded { output, .. } => Some(output),
            Self::Pending
            | Self::Starting
            | Self::Running { .. }
            | Self::Failed { .. }
            | Self::Cancelled { .. }
            | Self::Skipped
            | Self::Terminal => None,
        }
    }

    fn node_id(&self) -> Option<&SessionNodeId> {
        match self {
            Self::Running { node_id, .. } => Some(node_id),
            Self::Succeeded {
                node_id: Some(node_id),
                ..
            }
            | Self::Failed {
                node_id: Some(node_id),
                ..
            }
            | Self::Cancelled {
                node_id: Some(node_id),
            } => Some(node_id),
            Self::Pending
            | Self::Starting
            | Self::Succeeded { node_id: None, .. }
            | Self::Failed { node_id: None, .. }
            | Self::Cancelled { node_id: None }
            | Self::Skipped
            | Self::Terminal => None,
        }
    }
}

pub struct WorkflowMachine {
    graph: WorkflowGraph,
    objective: String,
    input: Value,
    statuses: BTreeMap<String, StateStatus>,
    terminal: Option<WorkflowTerminal>,
    entry_started: bool,
}

impl WorkflowMachine {
    pub fn new(
        graph: WorkflowGraph,
        objective: impl Into<String>,
        input: Value,
    ) -> Result<Self, GatewayError> {
        graph.validate()?;
        let statuses = graph
            .states
            .iter()
            .map(|state| (state.key.clone(), StateStatus::Pending))
            .collect();
        Ok(Self {
            graph,
            objective: objective.into(),
            input,
            statuses,
            terminal: None,
            entry_started: false,
        })
    }

    pub fn next_actions(&mut self) -> Result<Vec<WorkflowAction>, GatewayError> {
        if self.terminal.is_some() {
            return Ok(Vec::new());
        }
        let mut actions = Vec::new();
        loop {
            let mut changed = false;
            if !self.entry_started {
                self.entry_started = true;
                changed |= self.activate(&self.graph.entry.clone(), &mut actions)?;
            }

            let keys = self
                .graph
                .states
                .iter()
                .map(|state| state.key.clone())
                .collect::<Vec<_>>();
            for key in keys {
                if !matches!(self.statuses.get(&key), Some(StateStatus::Pending)) {
                    continue;
                }
                let incoming = self
                    .graph
                    .transitions
                    .iter()
                    .filter(|transition| transition.to == key)
                    .collect::<Vec<_>>();
                if incoming.is_empty() {
                    continue;
                }
                let all_sources_settled = incoming.iter().all(|transition| {
                    self.statuses
                        .get(&transition.from)
                        .is_some_and(StateStatus::settled)
                });
                let matched = incoming
                    .iter()
                    .filter(|transition| self.transition_matches(transition))
                    .count();
                let join = self.state(&key)?.join;
                let ready = match join {
                    WorkflowJoin::Any => matched > 0,
                    WorkflowJoin::AllSettled => all_sources_settled && matched > 0,
                };
                if ready {
                    changed |= self.activate(&key, &mut actions)?;
                } else if all_sources_settled && matched == 0 {
                    self.statuses.insert(key, StateStatus::Skipped);
                    changed = true;
                }
            }

            if self.terminal.is_some() {
                if let Some(terminal) = self.terminal.clone() {
                    actions.push(WorkflowAction::Complete(terminal));
                }
                break;
            }
            if !changed {
                let active = self.statuses.values().any(|status| {
                    matches!(status, StateStatus::Starting | StateStatus::Running { .. })
                });
                let pending = self
                    .statuses
                    .values()
                    .any(|status| matches!(status, StateStatus::Pending));
                if !active && pending {
                    let terminal = WorkflowTerminal {
                        success: false,
                        summary: "workflow policy reached no valid terminal transition".to_owned(),
                    };
                    self.terminal = Some(terminal.clone());
                    actions.push(WorkflowAction::Complete(terminal));
                }
                break;
            }
        }
        Ok(actions)
    }

    pub fn bind_invoke(&mut self, key: &str, node_id: SessionNodeId) -> Result<(), GatewayError> {
        let status = self.statuses.get_mut(key).ok_or_else(|| {
            GatewayError::InvalidWorkflowPlan(format!("unknown workflow state {key}"))
        })?;
        if !matches!(status, StateStatus::Starting) {
            return Err(GatewayError::Invariant(format!(
                "workflow state {key} is not waiting for a session binding"
            )));
        }
        *status = StateStatus::Running {
            node_id,
            text: String::new(),
        };
        Ok(())
    }

    pub fn observe(
        &mut self,
        node_id: &SessionNodeId,
        events: &[SessionEvent],
    ) -> Result<(), GatewayError> {
        let key = self
            .statuses
            .iter()
            .find_map(|(key, status)| (status.node_id() == Some(node_id)).then(|| key.clone()))
            .ok_or_else(|| {
                GatewayError::Invariant(format!("workflow has no running state for node {node_id}"))
            })?;
        let status = self.statuses.get_mut(&key).expect("workflow state exists");
        let StateStatus::Running {
            node_id: bound_node,
            text,
        } = status
        else {
            return Ok(());
        };
        for event in events {
            match event {
                SessionEvent::Text { text: chunk } => {
                    if !text.is_empty() && !text.ends_with('\n') {
                        text.push('\n');
                    }
                    text.push_str(chunk);
                }
                SessionEvent::Completed => {
                    *status = StateStatus::Succeeded {
                        node_id: Some(bound_node.clone()),
                        output: parse_output(text),
                    };
                    break;
                }
                SessionEvent::Failed { message } => {
                    *status = StateStatus::Failed {
                        node_id: Some(bound_node.clone()),
                        message: message.clone(),
                    };
                    break;
                }
                SessionEvent::Cancelled { .. } => {
                    *status = StateStatus::Cancelled {
                        node_id: Some(bound_node.clone()),
                    };
                    break;
                }
                SessionEvent::Thought { .. }
                | SessionEvent::ToolStarted { .. }
                | SessionEvent::ToolUpdated { .. }
                | SessionEvent::ToolFinished { .. }
                | SessionEvent::Terminal { .. }
                | SessionEvent::PermissionRequested { .. }
                | SessionEvent::QueueChanged { .. }
                | SessionEvent::Compacted => {}
            }
        }
        Ok(())
    }

    pub fn running_nodes(&self) -> Vec<SessionNodeId> {
        self.statuses
            .values()
            .filter_map(|status| match status {
                StateStatus::Running { node_id, .. } => Some(node_id.clone()),
                _ => None,
            })
            .collect()
    }

    pub fn first_bound_node(&self) -> Option<SessionNodeId> {
        self.graph.states.iter().find_map(|state| {
            self.statuses
                .get(&state.key)
                .and_then(StateStatus::node_id)
                .cloned()
        })
    }

    fn activate(
        &mut self,
        key: &str,
        actions: &mut Vec<WorkflowAction>,
    ) -> Result<bool, GatewayError> {
        if !matches!(self.statuses.get(key), Some(StateStatus::Pending)) {
            return Ok(false);
        }
        let state = self.state(key)?.clone();
        match state.kind {
            WorkflowStateKind::Invoke { role, objective } => {
                self.statuses.insert(key.to_owned(), StateStatus::Starting);
                actions.push(WorkflowAction::Invoke {
                    key: key.to_owned(),
                    role,
                    objective: objective.replace(OBJECTIVE_PLACEHOLDER, &self.objective),
                    required: state.required,
                    context: self.context(),
                });
            }
            WorkflowStateKind::Decision => {
                self.statuses.insert(
                    key.to_owned(),
                    StateStatus::Succeeded {
                        node_id: None,
                        output: Value::Null,
                    },
                );
            }
            WorkflowStateKind::Return { summary } => {
                let required_failures = self.required_failures();
                let terminal = if required_failures.is_empty() {
                    WorkflowTerminal {
                        success: true,
                        summary: summary.replace(OBJECTIVE_PLACEHOLDER, &self.objective),
                    }
                } else {
                    WorkflowTerminal {
                        success: false,
                        summary: format!(
                            "required workflow states failed: {}",
                            required_failures.join(", ")
                        ),
                    }
                };
                self.statuses.insert(key.to_owned(), StateStatus::Terminal);
                self.terminal = Some(terminal);
            }
            WorkflowStateKind::Fail { reason } => {
                self.statuses.insert(key.to_owned(), StateStatus::Terminal);
                self.terminal = Some(WorkflowTerminal {
                    success: false,
                    summary: reason.replace(OBJECTIVE_PLACEHOLDER, &self.objective),
                });
            }
        }
        Ok(true)
    }

    fn transition_matches(&self, transition: &WorkflowTransition) -> bool {
        let Some(source) = self.statuses.get(&transition.from) else {
            return false;
        };
        match &transition.when {
            WorkflowCondition::Always => source.settled(),
            WorkflowCondition::InputExists { path } => value_at_path(&self.input, path).is_some(),
            WorkflowCondition::InputMissing { path } => value_at_path(&self.input, path).is_none(),
            WorkflowCondition::OutputEquals { path, value } => source
                .output()
                .and_then(|output| value_at_path(output, path))
                .is_some_and(|found| scalar_string(found).as_deref() == Some(value.as_str())),
            WorkflowCondition::OutputContains { path, value } => source
                .output()
                .and_then(|output| value_at_path(output, path))
                .is_some_and(|found| value_contains(found, value)),
            WorkflowCondition::Outcome { status } => source.outcome() == Some(*status),
        }
    }

    fn context(&self) -> Value {
        let mut states = Map::new();
        for state in &self.graph.states {
            let Some(status) = self.statuses.get(&state.key) else {
                continue;
            };
            if !status.settled() {
                continue;
            }
            let mut value = Map::new();
            if let Some(outcome) = status.outcome() {
                value.insert(
                    "outcome".to_owned(),
                    Value::String(
                        match outcome {
                            WorkflowOutcomeStatus::Success => "success",
                            WorkflowOutcomeStatus::Failure => "failure",
                            WorkflowOutcomeStatus::Cancelled => "cancelled",
                            WorkflowOutcomeStatus::Skipped => "skipped",
                        }
                        .to_owned(),
                    ),
                );
            }
            if let Some(output) = status.output() {
                value.insert("output".to_owned(), output.clone());
            }
            if let StateStatus::Failed { message, .. } = status {
                value.insert("error".to_owned(), Value::String(message.clone()));
            }
            states.insert(state.key.clone(), Value::Object(value));
        }
        serde_json::json!({
            "objective": self.objective,
            "input": self.input,
            "states": states,
        })
    }

    fn required_failures(&self) -> Vec<String> {
        self.graph
            .states
            .iter()
            .filter(|state| state.required)
            .filter_map(|state| {
                self.statuses.get(&state.key).and_then(|status| {
                    matches!(
                        status,
                        StateStatus::Failed { .. } | StateStatus::Cancelled { .. }
                    )
                    .then(|| state.key.clone())
                })
            })
            .collect()
    }

    fn state(&self, key: &str) -> Result<&WorkflowGraphState, GatewayError> {
        self.graph
            .states
            .iter()
            .find(|state| state.key == key)
            .ok_or_else(|| {
                GatewayError::InvalidWorkflowPlan(format!("unknown workflow state {key}"))
            })
    }
}

fn validate_key(key: &str) -> Result<(), GatewayError> {
    if key.is_empty()
        || !key
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(GatewayError::InvalidWorkflowPlan(format!(
            "invalid workflow state key {key:?}"
        )));
    }
    Ok(())
}

fn reject_cycles<'a>(
    entry: &'a str,
    adjacency: &BTreeMap<&'a str, Vec<&'a str>>,
) -> Result<(), GatewayError> {
    fn visit<'a>(
        node: &'a str,
        adjacency: &BTreeMap<&'a str, Vec<&'a str>>,
        visiting: &mut BTreeSet<&'a str>,
        visited: &mut BTreeSet<&'a str>,
    ) -> Result<(), GatewayError> {
        if visited.contains(node) {
            return Ok(());
        }
        if !visiting.insert(node) {
            return Err(GatewayError::InvalidWorkflowPlan(format!(
                "workflow graph contains an unbounded cycle through {node}"
            )));
        }
        if let Some(next) = adjacency.get(node) {
            for target in next {
                visit(target, adjacency, visiting, visited)?;
            }
        }
        visiting.remove(node);
        visited.insert(node);
        Ok(())
    }

    visit(entry, adjacency, &mut BTreeSet::new(), &mut BTreeSet::new())
}

fn collect_reachable<'a>(
    node: &'a str,
    adjacency: &BTreeMap<&'a str, Vec<&'a str>>,
    reachable: &mut BTreeSet<&'a str>,
) {
    if !reachable.insert(node) {
        return;
    }
    if let Some(next) = adjacency.get(node) {
        for target in next {
            collect_reachable(target, adjacency, reachable);
        }
    }
}

fn value_at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    if path.trim().is_empty() || path == "." {
        return Some(value);
    }
    path.split('.')
        .filter(|part| !part.is_empty())
        .try_fold(value, |current, part| match current {
            Value::Object(object) => object.get(part),
            _ => None,
        })
}

fn scalar_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::Null | Value::Array(_) | Value::Object(_) => None,
    }
}

fn value_contains(value: &Value, expected: &str) -> bool {
    match value {
        Value::Array(values) => values.iter().any(|value| {
            scalar_string(value)
                .as_deref()
                .is_some_and(|value| value == expected)
        }),
        Value::String(value) => value
            .split(',')
            .map(str::trim)
            .any(|value| value == expected),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => false,
    }
}

fn parse_output(text: &str) -> Value {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Value::Null;
    }
    if let Ok(value) = serde_json::from_str(trimmed) {
        return value;
    }
    let fenced = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim);
    if let Some(fenced) = fenced {
        if let Ok(value) = serde_json::from_str(fenced) {
            return value;
        }
    }
    Value::String(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(key: &str, required: bool, kind: WorkflowStateKind) -> WorkflowGraphState {
        WorkflowGraphState {
            key: key.to_owned(),
            join: WorkflowJoin::Any,
            required,
            kind,
        }
    }

    fn edge(from: &str, to: &str, when: WorkflowCondition) -> WorkflowTransition {
        WorkflowTransition {
            from: from.to_owned(),
            to: to.to_owned(),
            when,
        }
    }

    fn bind_and_complete(machine: &mut WorkflowMachine, key: &str, sequence: u64, output: &str) {
        let node = SessionNodeId::parse(format!("node-{sequence}")).expect("node");
        machine.bind_invoke(key, node.clone()).expect("bind");
        machine
            .observe(
                &node,
                &[
                    SessionEvent::Text {
                        text: output.to_owned(),
                    },
                    SessionEvent::Completed,
                ],
            )
            .expect("observe");
    }

    #[test]
    fn supplied_plan_is_authoritative_and_skips_internal_planning() {
        let graph = WorkflowGraph {
            entry: "route-plan".to_owned(),
            states: vec![
                state("route-plan", false, WorkflowStateKind::Decision),
                state(
                    "plan",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("planner").expect("role"),
                        objective: "Plan {objective}".to_owned(),
                    },
                ),
                state(
                    "implement",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("implementer").expect("role"),
                        objective: "Implement {objective}".to_owned(),
                    },
                ),
                state(
                    "return",
                    false,
                    WorkflowStateKind::Return {
                        summary: "Implemented {objective}".to_owned(),
                    },
                ),
            ],
            transitions: vec![
                edge(
                    "route-plan",
                    "plan",
                    WorkflowCondition::InputMissing {
                        path: "plan".to_owned(),
                    },
                ),
                edge(
                    "route-plan",
                    "implement",
                    WorkflowCondition::InputExists {
                        path: "plan".to_owned(),
                    },
                ),
                edge("plan", "implement", WorkflowCondition::Always),
                edge("implement", "return", WorkflowCondition::Always),
            ],
        };
        let mut machine = WorkflowMachine::new(
            graph,
            "migrate storage",
            serde_json::json!({"plan": {"steps": ["copy", "cut over"]}}),
        )
        .expect("machine");
        let actions = machine.next_actions().expect("actions");
        assert_eq!(actions.len(), 1);
        let WorkflowAction::Invoke { key, context, .. } = &actions[0] else {
            panic!("invoke expected")
        };
        assert_eq!(key, "implement");
        assert_eq!(context["input"]["plan"]["steps"][0], "copy");
    }

    #[test]
    fn optional_review_failure_does_not_erase_successful_evidence() {
        let graph = WorkflowGraph {
            entry: "fanout".to_owned(),
            states: vec![
                state("fanout", false, WorkflowStateKind::Decision),
                state(
                    "required",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("tester").expect("role"),
                        objective: "Required review {objective}".to_owned(),
                    },
                ),
                state(
                    "optional",
                    false,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("critic").expect("role"),
                        objective: "Optional review {objective}".to_owned(),
                    },
                ),
                WorkflowGraphState {
                    key: "synthesize".to_owned(),
                    join: WorkflowJoin::AllSettled,
                    required: true,
                    kind: WorkflowStateKind::Invoke {
                        role: RoleId::parse("qa-synthesizer").expect("role"),
                        objective: "Synthesize {objective}".to_owned(),
                    },
                },
                state(
                    "return",
                    false,
                    WorkflowStateKind::Return {
                        summary: "QA complete".to_owned(),
                    },
                ),
            ],
            transitions: vec![
                edge("fanout", "required", WorkflowCondition::Always),
                edge("fanout", "optional", WorkflowCondition::Always),
                edge("required", "synthesize", WorkflowCondition::Always),
                edge("optional", "synthesize", WorkflowCondition::Always),
                edge("synthesize", "return", WorkflowCondition::Always),
            ],
        };
        let mut machine = WorkflowMachine::new(graph, "qa", Value::Null).expect("machine");
        let actions = machine.next_actions().expect("fanout");
        assert_eq!(actions.len(), 2);
        let required = SessionNodeId::parse("node-required").expect("node");
        let optional = SessionNodeId::parse("node-optional").expect("node");
        machine
            .bind_invoke("required", required.clone())
            .expect("bind");
        machine
            .bind_invoke("optional", optional.clone())
            .expect("bind");
        machine
            .observe(
                &required,
                &[
                    SessionEvent::Text {
                        text: "evidence".to_owned(),
                    },
                    SessionEvent::Completed,
                ],
            )
            .expect("required");
        machine
            .observe(
                &optional,
                &[SessionEvent::Failed {
                    message: "optional unavailable".to_owned(),
                }],
            )
            .expect("optional");
        let actions = machine.next_actions().expect("synthesis");
        let WorkflowAction::Invoke { key, context, .. } = &actions[0] else {
            panic!("synthesis invoke expected")
        };
        assert_eq!(key, "synthesize");
        assert_eq!(context["states"]["required"]["outcome"], "success");
        assert_eq!(context["states"]["optional"]["outcome"], "failure");
    }

    #[test]
    fn unreproduced_bug_takes_non_mutating_handoff() {
        let graph = WorkflowGraph {
            entry: "reproduce".to_owned(),
            states: vec![
                state(
                    "reproduce",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("reproducer").expect("role"),
                        objective: "Reproduce {objective}".to_owned(),
                    },
                ),
                state(
                    "implement",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("implementer").expect("role"),
                        objective: "Fix {objective}".to_owned(),
                    },
                ),
                state(
                    "inconclusive",
                    false,
                    WorkflowStateKind::Return {
                        summary: "Reproduction was inconclusive; no mutation performed".to_owned(),
                    },
                ),
                state(
                    "return",
                    false,
                    WorkflowStateKind::Return {
                        summary: "Debug repair accepted".to_owned(),
                    },
                ),
            ],
            transitions: vec![
                edge(
                    "reproduce",
                    "implement",
                    WorkflowCondition::OutputEquals {
                        path: "status".to_owned(),
                        value: "reproduced".to_owned(),
                    },
                ),
                edge(
                    "reproduce",
                    "inconclusive",
                    WorkflowCondition::OutputEquals {
                        path: "status".to_owned(),
                        value: "inconclusive".to_owned(),
                    },
                ),
                edge("implement", "return", WorkflowCondition::Always),
            ],
        };
        let mut machine = WorkflowMachine::new(graph, "bug", Value::Null).expect("machine");
        let _ = machine.next_actions().expect("reproduce");
        bind_and_complete(&mut machine, "reproduce", 1, r#"{"status":"inconclusive"}"#);
        let actions = machine.next_actions().expect("handoff");
        assert!(actions.iter().all(|action| !matches!(
            action,
            WorkflowAction::Invoke { key, .. } if key == "implement"
        )));
        assert!(matches!(
            actions.last(),
            Some(WorkflowAction::Complete(WorkflowTerminal {
                success: true,
                ..
            }))
        ));
    }

    #[test]
    fn bounded_acceptance_repair_fails_after_recheck_rejects() {
        let graph = WorkflowGraph {
            entry: "review".to_owned(),
            states: vec![
                state(
                    "review",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("critic").expect("role"),
                        objective: "Review {objective}".to_owned(),
                    },
                ),
                state(
                    "repair",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("implementer").expect("role"),
                        objective: "Repair {objective}".to_owned(),
                    },
                ),
                state(
                    "recheck",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("critic").expect("role"),
                        objective: "Recheck {objective}".to_owned(),
                    },
                ),
                state(
                    "return",
                    false,
                    WorkflowStateKind::Return {
                        summary: "Accepted".to_owned(),
                    },
                ),
                state(
                    "fail",
                    false,
                    WorkflowStateKind::Fail {
                        reason: "Acceptance findings remain after repair budget".to_owned(),
                    },
                ),
            ],
            transitions: vec![
                edge(
                    "review",
                    "return",
                    WorkflowCondition::OutputEquals {
                        path: "decision".to_owned(),
                        value: "accept".to_owned(),
                    },
                ),
                edge(
                    "review",
                    "repair",
                    WorkflowCondition::OutputEquals {
                        path: "decision".to_owned(),
                        value: "repair".to_owned(),
                    },
                ),
                edge(
                    "review",
                    "fail",
                    WorkflowCondition::OutputEquals {
                        path: "decision".to_owned(),
                        value: "fail".to_owned(),
                    },
                ),
                edge("repair", "recheck", WorkflowCondition::Always),
                edge(
                    "recheck",
                    "return",
                    WorkflowCondition::OutputEquals {
                        path: "decision".to_owned(),
                        value: "accept".to_owned(),
                    },
                ),
                edge(
                    "recheck",
                    "fail",
                    WorkflowCondition::OutputEquals {
                        path: "decision".to_owned(),
                        value: "repair".to_owned(),
                    },
                ),
                edge(
                    "recheck",
                    "fail",
                    WorkflowCondition::OutputEquals {
                        path: "decision".to_owned(),
                        value: "fail".to_owned(),
                    },
                ),
            ],
        };
        let mut machine = WorkflowMachine::new(graph, "change", Value::Null).expect("machine");
        let _ = machine.next_actions().expect("review");
        bind_and_complete(&mut machine, "review", 1, r#"{"decision":"repair"}"#);
        let actions = machine.next_actions().expect("repair");
        assert!(matches!(
            actions.first(),
            Some(WorkflowAction::Invoke { key, .. }) if key == "repair"
        ));
        bind_and_complete(&mut machine, "repair", 2, "done");
        let _ = machine.next_actions().expect("recheck");
        bind_and_complete(&mut machine, "recheck", 3, r#"{"decision":"repair"}"#);
        let actions = machine.next_actions().expect("terminal");
        assert!(matches!(
            actions.last(),
            Some(WorkflowAction::Complete(WorkflowTerminal {
                success: false,
                ..
            }))
        ));
    }

    #[test]
    fn research_classifier_skips_irrelevant_evidence_domains() {
        let graph = WorkflowGraph {
            entry: "classify".to_owned(),
            states: vec![
                state(
                    "classify",
                    true,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("researcher").expect("role"),
                        objective: "Classify evidence domains for {objective}".to_owned(),
                    },
                ),
                state(
                    "repository",
                    false,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("researcher").expect("role"),
                        objective: "Repository evidence for {objective}".to_owned(),
                    },
                ),
                state(
                    "ecosystem",
                    false,
                    WorkflowStateKind::Invoke {
                        role: RoleId::parse("researcher").expect("role"),
                        objective: "Ecosystem evidence for {objective}".to_owned(),
                    },
                ),
                WorkflowGraphState {
                    key: "challenge".to_owned(),
                    join: WorkflowJoin::AllSettled,
                    required: true,
                    kind: WorkflowStateKind::Invoke {
                        role: RoleId::parse("critic").expect("role"),
                        objective: "Challenge evidence for {objective}".to_owned(),
                    },
                },
                state(
                    "return",
                    false,
                    WorkflowStateKind::Return {
                        summary: "Research complete".to_owned(),
                    },
                ),
            ],
            transitions: vec![
                edge(
                    "classify",
                    "repository",
                    WorkflowCondition::OutputContains {
                        path: "domains".to_owned(),
                        value: "repository".to_owned(),
                    },
                ),
                edge(
                    "classify",
                    "ecosystem",
                    WorkflowCondition::OutputContains {
                        path: "domains".to_owned(),
                        value: "ecosystem".to_owned(),
                    },
                ),
                edge("repository", "challenge", WorkflowCondition::Always),
                edge("ecosystem", "challenge", WorkflowCondition::Always),
                edge("challenge", "return", WorkflowCondition::Always),
            ],
        };
        let mut machine = WorkflowMachine::new(graph, "question", Value::Null).expect("machine");
        let _ = machine.next_actions().expect("classify");
        bind_and_complete(&mut machine, "classify", 1, r#"{"domains":["repository"]}"#);
        let actions = machine.next_actions().expect("domain");
        assert_eq!(actions.len(), 1);
        assert!(matches!(
            actions.first(),
            Some(WorkflowAction::Invoke { key, .. }) if key == "repository"
        ));
    }
}
