use crate::{
    AcpSessionId, BackendId, DefinitionId, Difficulty, ModelConfig, ModelSelection, ObjectiveId,
    ObjectiveState, RoleId, RouterId, SessionNodeId, SessionTreeId, ThinkingLevel, WorkflowId,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

pub trait SessionRouter: Send + Sync + 'static {
    fn route(&self, request: &RoutingRequest) -> Result<RoutingDecision, GatewayError>;
}

pub trait Workflow: Send + Sync + 'static {
    fn plan(&self, request: &WorkflowRequest) -> Result<WorkflowPlan, GatewayError>;
}

pub trait AcpSessionFactory: Send + Sync + 'static {
    fn open(&self, request: SessionOpenRequest) -> Result<Box<dyn AcpSession>, GatewayError>;
}

pub trait AcpSession: Send + 'static {
    fn id(&self) -> &AcpSessionId;

    fn execute(&mut self, command: SessionCommand) -> Result<Vec<SessionEvent>, GatewayError>;
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RoutingRequest {
    pub tree_id: SessionTreeId,
    pub parent_node: Option<SessionNodeId>,
    pub role: RoleId,
    pub difficulty: Difficulty,
    pub objective: String,
    pub workflow: Option<WorkflowId>,
    pub available_backends: Vec<BackendId>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RoutingDecision {
    pub difficulty: Difficulty,
    pub model: ModelConfig,
    pub explanation: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowRequest {
    pub tree_id: SessionTreeId,
    pub objective: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowStep {
    pub key: String,
    pub parent: Option<String>,
    pub role: RoleId,
    pub objective: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct WorkflowPlan {
    pub steps: Vec<WorkflowStep>,
}

impl WorkflowPlan {
    pub fn builder() -> WorkflowPlanBuilder {
        WorkflowPlanBuilder::default()
    }

    pub(crate) fn validate(&self) -> Result<(), GatewayError> {
        if self.steps.is_empty() {
            return Err(GatewayError::InvalidWorkflowPlan(
                "workflow must contain at least one delegated session".to_owned(),
            ));
        }
        validate_steps(&self.steps)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct WorkflowPlanBuilder {
    steps: Vec<WorkflowStep>,
}

impl WorkflowPlanBuilder {
    pub fn step<P>(
        mut self,
        key: impl Into<String>,
        parent: Option<P>,
        role: RoleId,
        objective: impl Into<String>,
    ) -> Result<Self, GatewayError>
    where
        P: Into<String>,
    {
        self.steps.push(WorkflowStep {
            key: key.into(),
            parent: parent.map(Into::into),
            role,
            objective: objective.into(),
        });
        validate_steps(&self.steps)?;
        Ok(self)
    }

    pub fn build(self) -> Result<WorkflowPlan, GatewayError> {
        let plan = WorkflowPlan { steps: self.steps };
        plan.validate()?;
        Ok(plan)
    }
}

fn validate_steps(steps: &[WorkflowStep]) -> Result<(), GatewayError> {
    let mut seen = BTreeSet::new();
    for step in steps {
        if step.key.trim().is_empty() {
            return Err(GatewayError::InvalidWorkflowPlan(
                "workflow step key must not be empty".to_owned(),
            ));
        }
        if !seen.insert(step.key.clone()) {
            return Err(GatewayError::InvalidWorkflowPlan(format!(
                "duplicate workflow step key {}",
                step.key
            )));
        }
        if let Some(parent) = &step.parent {
            if !seen.contains(parent) {
                return Err(GatewayError::InvalidWorkflowPlan(format!(
                    "workflow step {} refers to parent {parent} before it is defined",
                    step.key
                )));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct StaticWorkflow {
    plan: WorkflowPlan,
}

impl StaticWorkflow {
    pub fn new(plan: WorkflowPlan) -> Result<Self, GatewayError> {
        plan.validate()?;
        Ok(Self { plan })
    }
}

impl Workflow for StaticWorkflow {
    fn plan(&self, _request: &WorkflowRequest) -> Result<WorkflowPlan, GatewayError> {
        Ok(self.plan.clone())
    }
}

#[derive(Clone, Debug)]
pub struct FixedRouter {
    model: ModelConfig,
    explanation: String,
}

impl FixedRouter {
    pub fn new(model: ModelConfig) -> Self {
        Self {
            model,
            explanation: "fixed model configuration selected by user configuration".to_owned(),
        }
    }

    pub fn explanation(mut self, explanation: impl Into<String>) -> Self {
        self.explanation = explanation.into();
        self
    }
}

impl SessionRouter for FixedRouter {
    fn route(&self, request: &RoutingRequest) -> Result<RoutingDecision, GatewayError> {
        if !request
            .available_backends
            .iter()
            .any(|backend| backend == &self.model.backend)
        {
            return Err(GatewayError::routing(format!(
                "fixed router selected unavailable backend {}",
                self.model.backend
            )));
        }
        Ok(RoutingDecision {
            difficulty: request.difficulty,
            model: self.model.clone(),
            explanation: self.explanation.clone(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionOpenKind {
    New { parent: Option<AcpSessionId> },
    Load { session_id: AcpSessionId },
    Resume { session_id: AcpSessionId },
    Fork { session_id: AcpSessionId },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionOpenRequest {
    pub tree_id: SessionTreeId,
    pub node_id: SessionNodeId,
    pub role: RoleId,
    pub difficulty: Difficulty,
    pub objective: String,
    pub model: ModelConfig,
    pub open: SessionOpenKind,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SessionImage {
    pub media_type: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum InteractionResponse {
    Selected(String),
    Confirmed(bool),
    Text(String),
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionCommand {
    Prompt {
        text: String,
        #[serde(default)]
        images: Vec<SessionImage>,
    },
    Steer {
        text: String,
        #[serde(default)]
        images: Vec<SessionImage>,
    },
    FollowUp {
        text: String,
        #[serde(default)]
        images: Vec<SessionImage>,
    },
    Compact {
        instructions: Option<String>,
    },
    Poll,
    Cancel,
    Rename {
        name: String,
    },
    SetModel {
        model: ModelSelection,
    },
    SetMode {
        mode_id: String,
    },
    SetThinking {
        level: ThinkingLevel,
    },
    Invoke {
        name: String,
        arguments: String,
    },
    RespondInteraction {
        request_id: String,
        response: InteractionResponse,
    },
    Close,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    Text {
        text: String,
    },
    Thought {
        text: String,
    },
    ToolStarted {
        call_id: String,
        name: String,
        raw_input_json: String,
        input_summary: String,
    },
    ToolUpdated {
        call_id: String,
        output: String,
    },
    ToolFinished {
        call_id: String,
        succeeded: bool,
        output_summary: String,
    },
    Terminal {
        terminal_id: String,
        output: String,
        exit_code: Option<i32>,
    },
    PermissionRequested {
        request_id: String,
        title: String,
        options: Vec<String>,
    },
    QueueChanged {
        steering: Vec<String>,
        follow_ups: Vec<String>,
    },
    Compacted,
    Completed,
    Failed {
        message: String,
    },
    Cancelled {
        reason: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct GatewayEvent {
    pub tree_id: SessionTreeId,
    pub node_id: SessionNodeId,
    pub session_id: AcpSessionId,
    pub event: SessionEvent,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TreeStartResult {
    pub tree_id: SessionTreeId,
    pub objective_id: ObjectiveId,
    pub root_node_id: SessionNodeId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayError {
    MissingDefinitions,
    DuplicateDefinition(DefinitionId),
    DuplicateRouter(RouterId),
    DuplicateWorkflow(WorkflowId),
    DuplicateBackend(BackendId),
    MissingRouter(RouterId),
    MissingWorkflow(WorkflowId),
    MissingBackend(BackendId),
    UnknownDefinition(DefinitionId),
    DuplicateTree(SessionTreeId),
    UnknownTree(SessionTreeId),
    UnknownNode(SessionNodeId),
    UnknownObjective(ObjectiveId),
    WorkflowNotAllowed {
        definition: DefinitionId,
        workflow: WorkflowId,
    },
    BackendNotAllowed {
        definition: DefinitionId,
        backend: BackendId,
    },
    DuplicateSession(AcpSessionId),
    InvalidWorkflowPlan(String),
    Routing(String),
    Workflow(String),
    Session(String),
    Invariant(String),
    IdentifierExhausted,
}

impl GatewayError {
    pub fn routing(message: impl Into<String>) -> Self {
        Self::Routing(message.into())
    }

    pub fn workflow(message: impl Into<String>) -> Self {
        Self::Workflow(message.into())
    }

    pub fn session(message: impl Into<String>) -> Self {
        Self::Session(message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingDefinitions => "configuration.missing_definitions",
            Self::DuplicateDefinition(_) => "configuration.duplicate_definition",
            Self::DuplicateRouter(_) => "configuration.duplicate_router",
            Self::DuplicateWorkflow(_) => "configuration.duplicate_workflow",
            Self::DuplicateBackend(_) => "configuration.duplicate_backend",
            Self::MissingRouter(_) => "configuration.missing_router",
            Self::MissingWorkflow(_) => "configuration.missing_workflow",
            Self::MissingBackend(_) => "configuration.missing_backend",
            Self::UnknownDefinition(_) => "definition.unknown",
            Self::DuplicateTree(_) => "tree.duplicate",
            Self::UnknownTree(_) => "tree.unknown",
            Self::UnknownNode(_) => "node.unknown",
            Self::UnknownObjective(_) => "objective.unknown",
            Self::WorkflowNotAllowed { .. } => "workflow.not_allowed",
            Self::BackendNotAllowed { .. } => "routing.backend_not_allowed",
            Self::DuplicateSession(_) => "session.duplicate",
            Self::InvalidWorkflowPlan(_) => "workflow.invalid_plan",
            Self::Routing(_) => "routing.failed",
            Self::Workflow(_) => "workflow.failed",
            Self::Session(_) => "session.failed",
            Self::Invariant(_) => "gateway.invariant",
            Self::IdentifierExhausted => "gateway.identifier_exhausted",
        }
    }
}

impl Display for GatewayError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingDefinitions => {
                formatter.write_str("gateway requires at least one session-tree definition")
            }
            Self::DuplicateDefinition(id) => write!(formatter, "duplicate definition {id}"),
            Self::DuplicateRouter(id) => write!(formatter, "duplicate router {id}"),
            Self::DuplicateWorkflow(id) => write!(formatter, "duplicate workflow {id}"),
            Self::DuplicateBackend(id) => write!(formatter, "duplicate backend {id}"),
            Self::MissingRouter(id) => write!(formatter, "router {id} is not registered"),
            Self::MissingWorkflow(id) => write!(formatter, "workflow {id} is not registered"),
            Self::MissingBackend(id) => write!(formatter, "backend {id} is not registered"),
            Self::UnknownDefinition(id) => write!(formatter, "unknown definition {id}"),
            Self::DuplicateTree(id) => write!(formatter, "duplicate session tree {id}"),
            Self::UnknownTree(id) => write!(formatter, "unknown session tree {id}"),
            Self::UnknownNode(id) => write!(formatter, "unknown session node {id}"),
            Self::UnknownObjective(id) => write!(formatter, "unknown objective {id}"),
            Self::WorkflowNotAllowed {
                definition,
                workflow,
            } => write!(
                formatter,
                "workflow {workflow} is not allowed by definition {definition}"
            ),
            Self::BackendNotAllowed {
                definition,
                backend,
            } => write!(
                formatter,
                "router selected backend {backend}, which is not allowed by definition {definition}"
            ),
            Self::DuplicateSession(id) => {
                write!(formatter, "downstream ACP session {id} is already attached")
            }
            Self::InvalidWorkflowPlan(message) => {
                write!(formatter, "invalid workflow plan: {message}")
            }
            Self::Routing(message) => write!(formatter, "routing failed: {message}"),
            Self::Workflow(message) => write!(formatter, "workflow failed: {message}"),
            Self::Session(message) => write!(formatter, "ACP session operation failed: {message}"),
            Self::Invariant(message) => write!(formatter, "gateway invariant failed: {message}"),
            Self::IdentifierExhausted => formatter.write_str("gateway identifiers are exhausted"),
        }
    }
}

impl Error for GatewayError {}

pub(crate) fn objective_terminal_state(events: &[SessionEvent]) -> Option<ObjectiveState> {
    events.iter().rev().find_map(|event| match event {
        SessionEvent::Completed => Some(ObjectiveState::Done),
        SessionEvent::Failed { .. } | SessionEvent::Cancelled { .. } => {
            Some(ObjectiveState::Blocked)
        }
        _ => None,
    })
}
