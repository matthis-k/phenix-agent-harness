#![forbid(unsafe_code)]

mod callables;
mod routing;

pub use callables::{CallableRegistry, CallableRegistryError};
pub use routing::{RoutingRegistry, RoutingRegistryError};

use phenix_backend::{
    Backend, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSessionRequest, ToolHostingCapability, ToolInvocation, ToolProvision, ToolResult,
};
use phenix_core::{
    CallableDescriptor, CallableId, CallableKind, ConfigRevisionId, ExecutionEvent,
    ExecutionEventKind, ExecutionId, ExecutionKind, ExecutionState, ExecutionSummary,
    ExecutionTarget, ModelTarget, RoutingProfile, SessionId, SessionSummary, ToolCallId,
    WorkflowDefinition,
};
use phenix_protocol::RuntimeSnapshot;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConductorError {
    UnknownSession(SessionId),
    UnknownExecution(ExecutionId),
    EmptyInput,
    InvalidLifecycle(ExecutionId),
    NonModelExecution(ExecutionId),
    PermissionRequired(CallableId),
    CallableRegistry(CallableRegistryError),
    Routing(RoutingRegistryError),
    Backend(BackendError),
}

impl Display for ConductorError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSession(id) => write!(f, "unknown session: {id}"),
            Self::UnknownExecution(id) => write!(f, "unknown execution: {id}"),
            Self::EmptyInput => f.write_str("input must not be empty"),
            Self::InvalidLifecycle(id) => write!(f, "execution is not runnable: {id}"),
            Self::NonModelExecution(id) => {
                write!(
                    f,
                    "execution is conductor-owned and has no backend session: {id}"
                )
            }
            Self::PermissionRequired(id) => write!(f, "permission required for callable: {id}"),
            Self::CallableRegistry(error) => Display::fmt(error, f),
            Self::Routing(error) => Display::fmt(error, f),
            Self::Backend(error) => Display::fmt(error, f),
        }
    }
}

impl Error for ConductorError {}

impl From<BackendError> for ConductorError {
    fn from(value: BackendError) -> Self {
        Self::Backend(value)
    }
}

impl From<CallableRegistryError> for ConductorError {
    fn from(value: CallableRegistryError) -> Self {
        Self::CallableRegistry(value)
    }
}

impl From<RoutingRegistryError> for ConductorError {
    fn from(value: RoutingRegistryError) -> Self {
        Self::Routing(value)
    }
}

#[derive(Clone, Debug)]
struct SessionRecord {
    summary: SessionSummary,
}

#[derive(Clone, Debug)]
enum ExecutionPayload {
    Model { prompt: String },
    Workflow { objective: String, next_step: usize },
}

#[derive(Clone, Debug)]
struct ExecutionRecord {
    summary: ExecutionSummary,
    payload: ExecutionPayload,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExecutionPlan {
    pub execution_id: ExecutionId,
    pub model: ModelTarget,
    pub tools: ToolProvision,
}

/// In-memory reference runtime proving conductor-owned semantics before
/// persistence and concrete backend adapters are introduced.
#[derive(Debug)]
pub struct ConductorRuntime {
    config_revision: ConfigRevisionId,
    sessions: BTreeMap<SessionId, SessionRecord>,
    executions: BTreeMap<ExecutionId, ExecutionRecord>,
    events: Vec<ExecutionEvent>,
    callables: CallableRegistry,
    routing: RoutingRegistry,
    next_session: u64,
    next_execution: u64,
    next_event: u64,
    next_tool_call: u64,
}

impl Default for ConductorRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl ConductorRuntime {
    #[must_use]
    pub fn new() -> Self {
        Self {
            config_revision: ConfigRevisionId::parse("config-1").expect("static config id"),
            sessions: BTreeMap::new(),
            executions: BTreeMap::new(),
            events: Vec::new(),
            callables: CallableRegistry::default(),
            routing: RoutingRegistry::default(),
            next_session: 0,
            next_execution: 0,
            next_event: 0,
            next_tool_call: 0,
        }
    }

    pub fn register_tool<F>(
        &mut self,
        descriptor: CallableDescriptor,
        handler: F,
    ) -> Result<(), ConductorError>
    where
        F: Fn(&str) -> Result<String, String> + Send + Sync + 'static,
    {
        self.callables.register_tool(descriptor, handler)?;
        Ok(())
    }

    pub fn register_agent(&mut self, descriptor: CallableDescriptor) -> Result<(), ConductorError> {
        self.callables.register_agent(descriptor)?;
        Ok(())
    }

    pub fn register_workflow(
        &mut self,
        definition: WorkflowDefinition,
    ) -> Result<(), ConductorError> {
        self.callables.register_workflow(definition)?;
        Ok(())
    }

    pub fn register_routing_profile(
        &mut self,
        profile: RoutingProfile,
    ) -> Result<(), ConductorError> {
        self.routing.register(profile)?;
        Ok(())
    }

    #[must_use]
    pub fn callable_descriptors(&self) -> Vec<CallableDescriptor> {
        self.callables.descriptors()
    }

    #[must_use]
    pub fn tool_descriptors(&self) -> Vec<CallableDescriptor> {
        self.callables.tool_descriptors()
    }

    pub fn create_session(
        &mut self,
        parent_session: Option<SessionId>,
        name: Option<String>,
        target: ExecutionTarget,
    ) -> Result<SessionSummary, ConductorError> {
        if let Some(parent) = parent_session.as_ref() {
            if !self.sessions.contains_key(parent) {
                return Err(ConductorError::UnknownSession(parent.clone()));
            }
        }
        let id = self.new_session_id();
        let summary = SessionSummary {
            id: id.clone(),
            parent_session,
            name,
            config_revision: self.config_revision.clone(),
            default_target: target,
        };
        self.sessions.insert(
            id,
            SessionRecord {
                summary: summary.clone(),
            },
        );
        Ok(summary)
    }

    pub fn fork_session(
        &mut self,
        source: &SessionId,
        name: Option<String>,
    ) -> Result<SessionSummary, ConductorError> {
        let source = self
            .sessions
            .get(source)
            .ok_or_else(|| ConductorError::UnknownSession(source.clone()))?
            .summary
            .clone();
        self.create_session(Some(source.id), name, source.default_target)
    }

    pub fn submit(
        &mut self,
        session_id: &SessionId,
        text: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let text = text.into();
        if text.trim().is_empty() {
            return Err(ConductorError::EmptyInput);
        }
        let target = self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?
            .summary
            .default_target
            .clone();
        let summary = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: session_id.clone(),
            parent_execution: None,
            kind: ExecutionKind::Root,
            callable: None,
            target,
            state: ExecutionState::Pending,
        };
        self.executions.insert(
            summary.id.clone(),
            ExecutionRecord {
                summary: summary.clone(),
                payload: ExecutionPayload::Model {
                    prompt: text.clone(),
                },
            },
        );
        self.push_event(&summary.id, ExecutionEventKind::UserInput { text })?;
        self.push_event(
            &summary.id,
            ExecutionEventKind::ExecutionStateChanged {
                state: ExecutionState::Pending,
            },
        )?;
        Ok(summary)
    }

    pub fn start_agent(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        objective: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let descriptor = self.callables.descriptor(callable)?.clone();
        if descriptor.kind != CallableKind::Agent {
            return Err(CallableRegistryError::WrongKind {
                callable: callable.clone(),
                expected: CallableKind::Agent,
                actual: descriptor.kind,
            }
            .into());
        }
        if descriptor.policy.requires_permission {
            return Err(ConductorError::PermissionRequired(callable.clone()));
        }
        self.create_child(
            parent_id,
            ExecutionKind::Agent,
            callable.clone(),
            ExecutionPayload::Model {
                prompt: objective.into(),
            },
        )
    }

    pub fn start_workflow(
        &mut self,
        parent_id: &ExecutionId,
        callable: &CallableId,
        objective: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let definition = self.callables.workflow(callable)?.clone();
        if definition.descriptor.policy.requires_permission {
            return Err(ConductorError::PermissionRequired(callable.clone()));
        }
        for step in &definition.steps {
            let descriptor = self.callables.descriptor(&step.callable)?;
            if descriptor.policy.requires_permission {
                return Err(ConductorError::PermissionRequired(step.callable.clone()));
            }
        }
        let summary = self.create_child(
            parent_id,
            ExecutionKind::Workflow,
            callable.clone(),
            ExecutionPayload::Workflow {
                objective: objective.into(),
                next_step: 0,
            },
        )?;
        self.set_state(&summary.id, ExecutionState::Running)?;
        self.advance_workflow(&summary.id)?;
        Ok(self
            .executions
            .get(&summary.id)
            .expect("workflow exists after creation")
            .summary
            .clone())
    }

    fn create_child(
        &mut self,
        parent_id: &ExecutionId,
        kind: ExecutionKind,
        callable: CallableId,
        payload: ExecutionPayload,
    ) -> Result<ExecutionSummary, ConductorError> {
        let parent = self
            .executions
            .get(parent_id)
            .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?
            .summary
            .clone();
        let child = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: parent.session_id,
            parent_execution: Some(parent.id.clone()),
            kind,
            callable: Some(callable),
            target: parent.target,
            state: ExecutionState::Pending,
        };
        self.executions.insert(
            child.id.clone(),
            ExecutionRecord {
                summary: child.clone(),
                payload,
            },
        );
        self.push_event(
            parent_id,
            ExecutionEventKind::ChildExecutionStarted {
                child: child.id.clone(),
            },
        )?;
        self.push_event(
            &child.id,
            ExecutionEventKind::ExecutionStateChanged {
                state: ExecutionState::Pending,
            },
        )?;
        Ok(child)
    }

    pub fn plan_execution(
        &self,
        execution_id: &ExecutionId,
    ) -> Result<ExecutionPlan, ConductorError> {
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        if execution.summary.kind == ExecutionKind::Workflow {
            return Err(ConductorError::NonModelExecution(execution_id.clone()));
        }
        let model = match &execution.summary.target {
            ExecutionTarget::Fixed(model) => model.clone(),
            ExecutionTarget::Routed(profile) => self
                .routing
                .resolve(profile, execution.summary.callable.as_ref())?,
        };
        Ok(ExecutionPlan {
            execution_id: execution_id.clone(),
            model,
            tools: ToolProvision {
                callables: self.callables.tool_descriptors(),
            },
        })
    }

    pub fn drive_execution(
        &mut self,
        execution_id: &ExecutionId,
        backend: &mut dyn Backend,
    ) -> Result<(), ConductorError> {
        let plan = self.plan_execution(execution_id)?;
        let record = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        if record.summary.state != ExecutionState::Pending {
            return Err(ConductorError::InvalidLifecycle(execution_id.clone()));
        }
        let ExecutionPayload::Model { prompt } = &record.payload else {
            return Err(ConductorError::NonModelExecution(execution_id.clone()));
        };
        if !plan.tools.callables.is_empty()
            && matches!(
                backend.capabilities().tool_hosting,
                ToolHostingCapability::Unsupported
            )
        {
            return Err(ConductorError::Backend(BackendError::Unsupported(
                "backend cannot host conductor-provisioned tools".to_owned(),
            )));
        }
        let prompt = prompt.clone();
        let allowed_tools = plan
            .tools
            .callables
            .iter()
            .map(|descriptor| descriptor.id.clone())
            .collect();
        let mut backend_session = backend.open_session(BackendSessionRequest {
            model: plan.model,
            tools: plan.tools,
        })?;
        self.set_state(execution_id, ExecutionState::Running)?;
        let request = BackendExecutionRequest {
            execution_id: execution_id.clone(),
            prompt,
        };
        let result = {
            let mut host = RuntimeHost {
                runtime: self,
                execution_id: execution_id.clone(),
                allowed_tools,
            };
            backend_session.execute(request, &mut host)
        };
        if let Err(error) = result {
            self.set_state(execution_id, ExecutionState::Failed)?;
            return Err(ConductorError::Backend(error));
        }
        let state = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?
            .summary
            .state
            .clone();
        if state == ExecutionState::Running {
            self.set_state(execution_id, ExecutionState::Completed)?;
        }
        Ok(())
    }

    pub fn cancel_execution(&mut self, root: &ExecutionId) -> Result<(), ConductorError> {
        if !self.executions.contains_key(root) {
            return Err(ConductorError::UnknownExecution(root.clone()));
        }
        let mut cancelled = BTreeSet::from([root.clone()]);
        loop {
            let before = cancelled.len();
            for (id, record) in &self.executions {
                if record
                    .summary
                    .parent_execution
                    .as_ref()
                    .is_some_and(|parent| cancelled.contains(parent))
                {
                    cancelled.insert(id.clone());
                }
            }
            if cancelled.len() == before {
                break;
            }
        }
        for id in cancelled {
            let state = self
                .executions
                .get(&id)
                .expect("collected execution")
                .summary
                .state
                .clone();
            if !is_terminal(&state) {
                self.set_state(&id, ExecutionState::Cancelled)?;
            }
        }
        Ok(())
    }

    pub fn push_event(
        &mut self,
        execution_id: &ExecutionId,
        kind: ExecutionEventKind,
    ) -> Result<ExecutionEvent, ConductorError> {
        let session_id = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?
            .summary
            .session_id
            .clone();
        self.next_event += 1;
        let event = ExecutionEvent {
            sequence: self.next_event,
            session_id,
            execution_id: execution_id.clone(),
            kind,
        };
        self.events.push(event.clone());
        Ok(event)
    }

    pub fn set_state(
        &mut self,
        execution_id: &ExecutionId,
        state: ExecutionState,
    ) -> Result<(), ConductorError> {
        let (current, parent) = {
            let execution = self
                .executions
                .get(execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
            (
                execution.summary.state.clone(),
                execution.summary.parent_execution.clone(),
            )
        };
        if is_terminal(&current) {
            return Err(ConductorError::InvalidLifecycle(execution_id.clone()));
        }
        self.executions
            .get_mut(execution_id)
            .expect("checked execution")
            .summary
            .state = state.clone();
        self.push_event(
            execution_id,
            ExecutionEventKind::ExecutionStateChanged {
                state: state.clone(),
            },
        )?;
        if is_terminal(&state) {
            if let Some(parent) = parent {
                self.push_event(
                    &parent,
                    ExecutionEventKind::ChildExecutionFinished {
                        child: execution_id.clone(),
                        state,
                    },
                )?;
                self.refresh_workflow(&parent)?;
            }
        }
        Ok(())
    }

    fn refresh_workflow(&mut self, execution_id: &ExecutionId) -> Result<(), ConductorError> {
        let Some(workflow) = self.executions.get(execution_id) else {
            return Err(ConductorError::UnknownExecution(execution_id.clone()));
        };
        if workflow.summary.kind != ExecutionKind::Workflow || is_terminal(&workflow.summary.state)
        {
            return Ok(());
        }
        let states: Vec<ExecutionState> = self
            .executions
            .values()
            .filter(|record| record.summary.parent_execution.as_ref() == Some(execution_id))
            .map(|record| record.summary.state.clone())
            .collect();
        if states.contains(&ExecutionState::Failed) {
            self.set_state(execution_id, ExecutionState::Failed)?;
            return Ok(());
        }
        if states.contains(&ExecutionState::Cancelled) {
            self.set_state(execution_id, ExecutionState::Cancelled)?;
            return Ok(());
        }
        if states.contains(&ExecutionState::Interrupted) {
            self.set_state(execution_id, ExecutionState::Interrupted)?;
            return Ok(());
        }
        if states.iter().any(|state| !is_terminal(state)) {
            return Ok(());
        }
        self.advance_workflow(execution_id)
    }

    fn advance_workflow(&mut self, execution_id: &ExecutionId) -> Result<(), ConductorError> {
        let (callable, objective, next_step, state) = {
            let execution = self
                .executions
                .get(execution_id)
                .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
            let ExecutionPayload::Workflow {
                objective,
                next_step,
            } = &execution.payload
            else {
                return Err(ConductorError::NonModelExecution(execution_id.clone()));
            };
            (
                execution
                    .summary
                    .callable
                    .clone()
                    .expect("workflow execution has callable"),
                objective.clone(),
                *next_step,
                execution.summary.state.clone(),
            )
        };
        if state != ExecutionState::Running {
            return Ok(());
        }
        let definition = self.callables.workflow(&callable)?.clone();
        if next_step >= definition.steps.len() {
            self.set_state(execution_id, ExecutionState::Completed)?;
            return Ok(());
        }
        let step = definition.steps[next_step].clone();
        let ExecutionPayload::Workflow { next_step, .. } = &mut self
            .executions
            .get_mut(execution_id)
            .expect("workflow exists")
            .payload
        else {
            unreachable!("workflow execution payload")
        };
        *next_step += 1;
        self.start_agent(
            execution_id,
            &step.callable,
            step.objective.unwrap_or(objective),
        )?;
        Ok(())
    }

    #[must_use]
    pub fn events_since(&self, sequence: u64) -> Vec<ExecutionEvent> {
        self.events
            .iter()
            .filter(|event| event.sequence > sequence)
            .cloned()
            .collect()
    }

    #[must_use]
    pub fn snapshot(&self) -> RuntimeSnapshot {
        RuntimeSnapshot {
            sessions: self
                .sessions
                .values()
                .map(|record| record.summary.clone())
                .collect(),
            executions: self
                .executions
                .values()
                .map(|record| record.summary.clone())
                .collect(),
            last_event_sequence: self.next_event,
        }
    }

    fn invoke_tool(
        &mut self,
        execution_id: &ExecutionId,
        allowed_tools: &BTreeSet<CallableId>,
        invocation: ToolInvocation,
    ) -> Result<ToolResult, BackendError> {
        if !allowed_tools.contains(&invocation.callable)
            || !self.callables.contains(&invocation.callable)
        {
            return Err(BackendError::Protocol(format!(
                "backend invoked unprovisioned tool {}",
                invocation.callable
            )));
        }
        let tool_call_id = self.new_tool_call_id();
        self.push_event(
            execution_id,
            ExecutionEventKind::ToolCallStarted {
                tool_call_id: tool_call_id.clone(),
                callable: invocation.callable.clone(),
            },
        )
        .map_err(conductor_protocol_error)?;
        self.push_event(
            execution_id,
            ExecutionEventKind::ToolCallArguments {
                tool_call_id: tool_call_id.clone(),
                arguments: invocation.arguments_json.clone(),
            },
        )
        .map_err(conductor_protocol_error)?;

        let result = match serde_json::from_str::<Value>(&invocation.arguments_json) {
            Ok(_) => self
                .callables
                .invoke_tool(&invocation.callable, &invocation.arguments_json)
                .map_err(|error| BackendError::Protocol(error.to_string()))?,
            Err(error) => ToolResult {
                output: format!("invalid JSON tool arguments: {error}"),
                success: false,
            },
        };
        self.push_event(
            execution_id,
            ExecutionEventKind::ToolCallFinished {
                tool_call_id,
                output: result.output.clone(),
                success: result.success,
            },
        )
        .map_err(conductor_protocol_error)?;
        Ok(result)
    }

    fn new_session_id(&mut self) -> SessionId {
        self.next_session += 1;
        SessionId::parse(format!("session-{}", self.next_session)).expect("generated id")
    }

    fn new_execution_id(&mut self) -> ExecutionId {
        self.next_execution += 1;
        ExecutionId::parse(format!("execution-{}", self.next_execution)).expect("generated id")
    }

    fn new_tool_call_id(&mut self) -> ToolCallId {
        self.next_tool_call += 1;
        ToolCallId::parse(format!("tool-call-{}", self.next_tool_call)).expect("generated id")
    }
}

fn conductor_protocol_error(error: ConductorError) -> BackendError {
    BackendError::Protocol(error.to_string())
}

fn is_terminal(state: &ExecutionState) -> bool {
    matches!(
        state,
        ExecutionState::Completed
            | ExecutionState::Failed
            | ExecutionState::Cancelled
            | ExecutionState::Interrupted
    )
}

struct RuntimeHost<'a> {
    runtime: &'a mut ConductorRuntime,
    execution_id: ExecutionId,
    allowed_tools: BTreeSet<CallableId>,
}

impl BackendHost for RuntimeHost<'_> {
    fn emit(&mut self, event: BackendEvent) -> Result<(), BackendError> {
        let event = match event {
            BackendEvent::ContentDelta(text) => ExecutionEventKind::AssistantContentDelta { text },
            BackendEvent::ReasoningDelta(text) => ExecutionEventKind::ReasoningDelta { text },
        };
        self.runtime
            .push_event(&self.execution_id, event)
            .map(|_| ())
            .map_err(conductor_protocol_error)
    }

    fn invoke_tool(&mut self, invocation: ToolInvocation) -> Result<ToolResult, BackendError> {
        self.runtime
            .invoke_tool(&self.execution_id, &self.allowed_tools, invocation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{
        BackendId, CallablePolicy, CapabilitySet, InferenceOptions, ModelId, ProviderId,
    };
    use serde_json::json;

    fn fixed(name: &str) -> ExecutionTarget {
        ExecutionTarget::Fixed(ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse(name).unwrap(),
            inference: InferenceOptions::default(),
        })
    }

    fn agent(id: &str) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind: CallableKind::Agent,
            description: "test agent".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    #[test]
    fn session_lineage_is_distinct_from_execution_parentage() {
        let mut runtime = ConductorRuntime::new();
        let root = runtime.create_session(None, None, fixed("a")).unwrap();
        let fork = runtime.fork_session(&root.id, None).unwrap();
        let execution = runtime.submit(&fork.id, "work").unwrap();
        assert_eq!(fork.parent_session, Some(root.id));
        assert_eq!(execution.parent_execution, None);
    }

    #[test]
    fn fixed_parent_forces_callable_child_target() {
        let mut runtime = ConductorRuntime::new();
        runtime.register_agent(agent("scout")).unwrap();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let root = runtime.submit(&session.id, "work").unwrap();
        let child = runtime
            .start_agent(&root.id, &CallableId::parse("scout").unwrap(), "child")
            .unwrap();
        assert_eq!(child.target, fixed("fixed"));
    }

    #[test]
    fn cancellation_cascades_to_descendants() {
        let mut runtime = ConductorRuntime::new();
        runtime.register_agent(agent("scout")).unwrap();
        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        let root = runtime.submit(&session.id, "work").unwrap();
        let child = runtime
            .start_agent(&root.id, &CallableId::parse("scout").unwrap(), "child")
            .unwrap();
        runtime.cancel_execution(&root.id).unwrap();
        let snapshot = runtime.snapshot();
        assert!(snapshot
            .executions
            .iter()
            .filter(|execution| execution.id == root.id || execution.id == child.id)
            .all(|execution| execution.state == ExecutionState::Cancelled));
    }
}
