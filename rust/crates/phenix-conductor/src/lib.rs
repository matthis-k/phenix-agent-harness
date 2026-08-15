#![forbid(unsafe_code)]

use phenix_runtime_api::{
    CallableDescriptor, CallableId, ExecutionEvent, ExecutionEventKind, ExecutionId, ExecutionKind,
    ExecutionState, ExecutionSummary, ExecutionTarget, RuntimeSnapshot, SessionId, SessionSummary,
};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt::{self, Display, Formatter};

#[derive(Debug, Eq, PartialEq)]
pub enum ConductorError {
    UnknownSession(SessionId),
    UnknownExecution(ExecutionId),
    UnknownCallable(CallableId),
    InvalidChildCallable(CallableId),
    EmptyInput,
}

impl Display for ConductorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownSession(id) => write!(formatter, "unknown session: {id}"),
            Self::UnknownExecution(id) => write!(formatter, "unknown execution: {id}"),
            Self::UnknownCallable(id) => write!(formatter, "unknown callable: {id}"),
            Self::InvalidChildCallable(id) => {
                write!(formatter, "callable cannot create an execution child: {id}")
            }
            Self::EmptyInput => formatter.write_str("input must not be empty"),
        }
    }
}

impl Error for ConductorError {}

#[derive(Clone, Debug)]
struct SessionRecord {
    summary: SessionSummary,
}

/// Sole owner of Phenix application state.
///
/// Frontends project snapshots/events from this state. Backend sessions are
/// implementation details of adapters and never become Phenix session IDs.
#[derive(Debug, Default)]
pub struct ConductorRuntime {
    sessions: BTreeMap<SessionId, SessionRecord>,
    executions: BTreeMap<ExecutionId, ExecutionSummary>,
    callables: BTreeMap<CallableId, CallableDescriptor>,
    events: Vec<ExecutionEvent>,
    next_session: u64,
    next_execution: u64,
    next_event: u64,
}

impl ConductorRuntime {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_callable(&mut self, callable: CallableDescriptor) {
        self.callables.insert(callable.id.clone(), callable);
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
        target: Option<ExecutionTarget>,
        text: impl Into<String>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let text = text.into();
        if text.trim().is_empty() {
            return Err(ConductorError::EmptyInput);
        }
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| ConductorError::UnknownSession(session_id.clone()))?;
        let target = target.unwrap_or_else(|| session.summary.default_target.clone());
        let execution = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: session_id.clone(),
            parent_execution: None,
            kind: ExecutionKind::Root,
            callable: None,
            target,
            state: ExecutionState::Running,
        };
        self.executions
            .insert(execution.id.clone(), execution.clone());
        self.push_event(&execution.id, ExecutionEventKind::UserInput { text })?;
        self.push_event(
            &execution.id,
            ExecutionEventKind::StateChanged {
                state: ExecutionState::Running,
            },
        )?;
        Ok(execution)
    }

    pub fn start_child(
        &mut self,
        parent_id: &ExecutionId,
        callable_id: &CallableId,
        requested_target: Option<ExecutionTarget>,
    ) -> Result<ExecutionSummary, ConductorError> {
        let parent = self
            .executions
            .get(parent_id)
            .ok_or_else(|| ConductorError::UnknownExecution(parent_id.clone()))?
            .clone();
        let callable = self
            .callables
            .get(callable_id)
            .ok_or_else(|| ConductorError::UnknownCallable(callable_id.clone()))?;

        let target = resolve_child_target(&parent.target, requested_target);
        let kind = match callable.kind {
            phenix_runtime_api::CallableKind::Agent => ExecutionKind::Agent,
            phenix_runtime_api::CallableKind::Workflow => ExecutionKind::Workflow,
            phenix_runtime_api::CallableKind::Tool => {
                return Err(ConductorError::InvalidChildCallable(callable_id.clone()));
            }
        };
        let child = ExecutionSummary {
            id: self.new_execution_id(),
            session_id: parent.session_id.clone(),
            parent_execution: Some(parent.id.clone()),
            kind,
            callable: Some(callable_id.clone()),
            target,
            state: ExecutionState::Running,
        };
        self.executions.insert(child.id.clone(), child.clone());
        self.push_event(
            parent_id,
            ExecutionEventKind::ChildExecutionStarted {
                child: child.id.clone(),
            },
        )?;
        Ok(child)
    }

    pub fn push_event(
        &mut self,
        execution_id: &ExecutionId,
        kind: ExecutionEventKind,
    ) -> Result<ExecutionEvent, ConductorError> {
        let execution = self
            .executions
            .get(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        self.next_event += 1;
        let event = ExecutionEvent {
            sequence: self.next_event,
            session_id: execution.session_id.clone(),
            execution_id: execution_id.clone(),
            kind,
        };
        self.events.push(event.clone());
        Ok(event)
    }

    pub fn set_execution_state(
        &mut self,
        execution_id: &ExecutionId,
        state: ExecutionState,
    ) -> Result<(), ConductorError> {
        let execution = self
            .executions
            .get_mut(execution_id)
            .ok_or_else(|| ConductorError::UnknownExecution(execution_id.clone()))?;
        execution.state = state.clone();
        self.push_event(execution_id, ExecutionEventKind::StateChanged { state })?;
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
            executions: self.executions.values().cloned().collect(),
            callables: self.callables.values().cloned().collect(),
            last_event_sequence: self.next_event,
        }
    }

    fn new_session_id(&mut self) -> SessionId {
        self.next_session += 1;
        SessionId::parse(format!("session-{}", self.next_session)).expect("generated session ID")
    }

    fn new_execution_id(&mut self) -> ExecutionId {
        self.next_execution += 1;
        ExecutionId::parse(format!("execution-{}", self.next_execution))
            .expect("generated execution ID")
    }
}

/// A concrete model selected at the root is an execution-tree invariant. A
/// routed root may refine a child to another routed profile or a concrete model.
#[must_use]
pub fn resolve_child_target(
    parent: &ExecutionTarget,
    requested: Option<ExecutionTarget>,
) -> ExecutionTarget {
    match parent {
        ExecutionTarget::Fixed { .. } => parent.clone(),
        ExecutionTarget::Routed { .. } => requested.unwrap_or_else(|| parent.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_runtime_api::{CallableKind, ModelTarget};

    fn fixed(model: &str) -> ExecutionTarget {
        ExecutionTarget::Fixed {
            model: ModelTarget {
                backend: "mock".to_owned(),
                provider: "mock".to_owned(),
                model: model.to_owned(),
            },
        }
    }

    fn callable(id: &str, kind: CallableKind) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind,
            description: "callable".to_owned(),
            input_schema: "{}".to_owned(),
            output_schema: "{}".to_owned(),
        }
    }

    fn agent(id: &str) -> CallableDescriptor {
        callable(id, CallableKind::Agent)
    }

    #[test]
    fn session_lineage_and_execution_parentage_are_distinct() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime
            .create_session(None, Some("root".to_owned()), fixed("a"))
            .unwrap();
        let fork = runtime
            .fork_session(&session.id, Some("fork".to_owned()))
            .unwrap();
        let root_execution = runtime.submit(&fork.id, None, "work").unwrap();

        assert_eq!(fork.parent_session, Some(session.id));
        assert_eq!(root_execution.parent_execution, None);
        assert_eq!(root_execution.session_id, fork.id);
    }

    #[test]
    fn fixed_root_forces_the_same_target_for_children() {
        let mut runtime = ConductorRuntime::new();
        runtime.register_callable(agent("agent.worker"));
        let session = runtime.create_session(None, None, fixed("fixed")).unwrap();
        let root = runtime.submit(&session.id, None, "work").unwrap();
        let child = runtime
            .start_child(
                &root.id,
                &CallableId::parse("agent.worker").unwrap(),
                Some(ExecutionTarget::Routed {
                    profile: "should-not-win".to_owned(),
                }),
            )
            .unwrap();

        assert_eq!(child.target, fixed("fixed"));
    }

    #[test]
    fn routed_root_may_refine_a_child_target() {
        let mut runtime = ConductorRuntime::new();
        runtime.register_callable(agent("agent.worker"));
        let session = runtime
            .create_session(
                None,
                None,
                ExecutionTarget::Routed {
                    profile: "mixed".to_owned(),
                },
            )
            .unwrap();
        let root = runtime.submit(&session.id, None, "work").unwrap();
        let child = runtime
            .start_child(
                &root.id,
                &CallableId::parse("agent.worker").unwrap(),
                Some(fixed("worker-model")),
            )
            .unwrap();

        assert_eq!(child.target, fixed("worker-model"));
    }

    #[test]
    fn tools_do_not_create_execution_children() {
        let mut runtime = ConductorRuntime::new();
        let tool_id = CallableId::parse("tool.read").unwrap();
        runtime.register_callable(callable(tool_id.as_str(), CallableKind::Tool));
        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        let root = runtime.submit(&session.id, None, "work").unwrap();

        let error = runtime.start_child(&root.id, &tool_id, None).unwrap_err();

        assert_eq!(error, ConductorError::InvalidChildCallable(tool_id));
        assert_eq!(runtime.snapshot().executions.len(), 1);
    }

    #[test]
    fn execution_events_are_canonically_ordered() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime.create_session(None, None, fixed("a")).unwrap();
        let root = runtime.submit(&session.id, None, "work").unwrap();
        runtime
            .push_event(
                &root.id,
                ExecutionEventKind::ReasoningDelta {
                    text: "think".to_owned(),
                },
            )
            .unwrap();
        runtime
            .push_event(
                &root.id,
                ExecutionEventKind::AssistantContentDelta {
                    text: "answer".to_owned(),
                },
            )
            .unwrap();

        let events = runtime.events_since(0);
        assert!(events
            .windows(2)
            .all(|pair| pair[0].sequence < pair[1].sequence));
        assert_eq!(
            events.last().unwrap().sequence,
            runtime.snapshot().last_event_sequence
        );
    }
}
