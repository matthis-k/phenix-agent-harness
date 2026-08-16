#![forbid(unsafe_code)]

use phenix_backend::{
    Backend, BackendError, BackendEvent, BackendExecutionRequest, BackendHost,
    BackendSessionRequest, ToolInvocation, ToolProvision, ToolResult,
};
use phenix_core::{
    ConfigRevisionId, ExecutionEvent, ExecutionEventKind, ExecutionId, ExecutionKind,
    ExecutionState, ExecutionSummary, ExecutionTarget, ModelTarget, SessionId, SessionSummary,
};
use phenix_protocol::RuntimeSnapshot;
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConductorError {
    UnknownSession(SessionId),
    UnknownExecution(ExecutionId),
    EmptyInput,
    InvalidChildKind,
    InvalidLifecycle(ExecutionId),
    RoutingUnavailable,
    Backend(BackendError),
}

impl Display for ConductorError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSession(id) => write!(f, "unknown session: {id}"),
            Self::UnknownExecution(id) => write!(f, "unknown execution: {id}"),
            Self::EmptyInput => f.write_str("input must not be empty"),
            Self::InvalidChildKind => f.write_str("root is not a valid child execution kind"),
            Self::InvalidLifecycle(id) => write!(f, "execution is not runnable: {id}"),
            Self::RoutingUnavailable => f.write_str("routing is not implemented until R5"),
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

#[derive(Clone, Debug)]
struct SessionRecord {
    summary: SessionSummary,
}

#[derive(Clone, Debug)]
struct ExecutionRecord {
    summary: ExecutionSummary,
    prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionPlan {
    pub execution_id: ExecutionId,
    pub model: ModelTarget,
}

/// In-memory reference runtime used to prove the runtime model before any real
/// backend adapter or persistence layer is introduced.
#[derive(Debug)]
pub struct ConductorRuntime {
    config_revision: ConfigRevisionId,
    sessions: BTreeMap<SessionId, SessionRecord>,
    executions: BTreeMap<ExecutionId, ExecutionRecord>,
    events: Vec<ExecutionEvent>,
    next_session: u64,
    next_execution: u64,
    next_event: u64,
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
            next_session: 0,
            next_execution: 0,
            next_event: 0,
        }
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
                prompt: text.clone(),
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

    /// Creates a computation child without introducing callable semantics yet.
    /// R5 will make agent/workflow callables the public source of child nodes.
    pub fn start_child(
        &mut self,
        parent_id: &ExecutionId,
        kind: ExecutionKind,
        requested_target: Option<ExecutionTarget>,
        objective: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        if kind == ExecutionKind::Root {
            return Err(ConductorError::InvalidChildKind);
        }
        let parent = self
            .executions
            .get(parent_id)
            .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?
            .summary
            .clone();
        let target = match &parent.target {
            ExecutionTarget::Fixed(_) => parent.target.clone(),
            ExecutionTarget::Routed(_) => requested_target.unwrap_or_else(|| parent.target.clone()),
        };
        let child = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: parent.session_id,
            parent_execution: Some(parent.id.clone()),
            kind,
            callable: None,
            target,
            state: ExecutionState::Pending,
        };
        self.executions.insert(
            child.id.clone(),
            ExecutionRecord {
                summary: child.clone(),
                prompt: objective.into(),
            },
        );
        self.push_event(
            parent_id,
            ExecutionEventKind::ChildExecutionStarted {
                child: child.id.clone(),
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
        match &execution.summary.target {
            ExecutionTarget::Fixed(model) => Ok(ExecutionPlan {
                execution_id: execution_id.clone(),
                model: model.clone(),
            }),
            ExecutionTarget::Routed(_) => Err(ConductorError::RoutingUnavailable),
        }
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
        let prompt = record.prompt.clone();
        let mut backend_session = backend.open_session(BackendSessionRequest {
            model: plan.model,
            tools: ToolProvision {
                callables: Vec::new(),
            },
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
        let current = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?
            .summary
            .state
            .clone();
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
            ExecutionEventKind::ExecutionStateChanged { state },
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

    fn new_session_id(&mut self) -> SessionId {
        self.next_session += 1;
        SessionId::parse(format!("session-{}", self.next_session)).expect("generated id")
    }
    fn new_execution_id(&mut self) -> ExecutionId {
        self.next_execution += 1;
        ExecutionId::parse(format!("execution-{}", self.next_execution)).expect("generated id")
    }
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
            .map_err(|error| BackendError::Protocol(error.to_string()))
    }

    fn invoke_tool(&mut self, _invocation: ToolInvocation) -> Result<ToolResult, BackendError> {
        Err(BackendError::Unsupported(
            "tool invocation is introduced in R4".to_owned(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{BackendId, InferenceOptions, ModelId, ProviderId, RoutingProfileId};

    fn fixed(name: &str) -> ExecutionTarget {
        ExecutionTarget::Fixed(ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse(name).unwrap(),
            inference: InferenceOptions::default(),
        })
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
    fn fixed_parent_forces_child_target() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let root = runtime.submit(&session.id, "work").unwrap();
        let child = runtime
            .start_child(
                &root.id,
                ExecutionKind::Agent,
                Some(ExecutionTarget::Routed(
                    RoutingProfileId::parse("ignored").unwrap(),
                )),
                "child",
            )
            .unwrap();
        assert_eq!(child.target, fixed("fixed"));
    }

    #[test]
    fn cancellation_cascades_to_descendants() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        let root = runtime.submit(&session.id, "work").unwrap();
        let child = runtime
            .start_child(&root.id, ExecutionKind::Agent, None, "child")
            .unwrap();
        runtime.cancel_execution(&root.id).unwrap();
        let snapshot = runtime.snapshot();
        assert!(snapshot
            .executions
            .iter()
            .filter(|e| e.id == root.id || e.id == child.id)
            .all(|e| e.state == ExecutionState::Cancelled));
    }
}
