use crate::{ExecutionPayload, ExecutionRecord, SessionRecord};
use phenix_core::{
    ConfigRevisionId, ExecutionEvent, ExecutionEventKind, ExecutionId, ExecutionKind,
    ExecutionState, ExecutionSummary, ExecutionTarget, ModelTarget, SessionId, SessionState,
    SessionSummary, ToolCallId,
};
use serde::{Deserialize, Serialize};
use std::collections::{btree_map::Entry, BTreeMap};
use std::error::Error;
use std::fmt::{self, Display, Formatter};

pub const JOURNAL_FORMAT_VERSION: u64 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JournalExecutionPayload {
    Invocation { input: String },
    Orchestration { objective: String, next_node: usize },
}

impl From<&ExecutionPayload> for JournalExecutionPayload {
    fn from(value: &ExecutionPayload) -> Self {
        match value {
            ExecutionPayload::Invocation { input } => Self::Invocation {
                input: input.clone(),
            },
            ExecutionPayload::Orchestration {
                objective,
                next_node,
            } => Self::Orchestration {
                objective: objective.clone(),
                next_node: *next_node,
            },
        }
    }
}

impl From<JournalExecutionPayload> for ExecutionPayload {
    fn from(value: JournalExecutionPayload) -> Self {
        match value {
            JournalExecutionPayload::Invocation { input } => Self::Invocation { input },
            JournalExecutionPayload::Orchestration {
                objective,
                next_node,
            } => Self::Orchestration {
                objective,
                next_node,
            },
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ResolvedRoute {
    pub requested_target: ExecutionTarget,
    pub model: ModelTarget,
    pub config_revision: ConfigRevisionId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DomainEvent {
    SessionCreated {
        session: SessionSummary,
    },
    SessionRenamed {
        session_id: SessionId,
        name: String,
    },
    SessionTargetChanged {
        session_id: SessionId,
        target: ExecutionTarget,
    },
    SessionClosed {
        session_id: SessionId,
    },
    ExecutionCreated {
        execution: ExecutionSummary,
        payload: JournalExecutionPayload,
    },
    ExecutionStateChanged {
        execution_id: ExecutionId,
        state: ExecutionState,
    },
    OrchestrationAdvanced {
        execution_id: ExecutionId,
        next_node: usize,
    },
    InvocationResolved {
        execution_id: ExecutionId,
        route: ResolvedRoute,
    },
    FrontendEvent {
        event: ExecutionEvent,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub sequence: u64,
    pub event: DomainEvent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RuntimeJournal {
    pub format_version: u64,
    pub config_revision: ConfigRevisionId,
    pub entries: Vec<JournalEntry>,
}

impl RuntimeJournal {
    #[must_use]
    pub fn new(config_revision: ConfigRevisionId) -> Self {
        Self {
            format_version: JOURNAL_FORMAT_VERSION,
            config_revision,
            entries: Vec::new(),
        }
    }

    pub fn validate_structure(&self) -> Result<(), JournalError> {
        if self.format_version != JOURNAL_FORMAT_VERSION {
            return Err(JournalError::InvalidFormat(format!(
                "unsupported journal format version: {}",
                self.format_version
            )));
        }
        for (index, entry) in self.entries.iter().enumerate() {
            let expected = u64::try_from(index)
                .map_err(|_| JournalError::InvalidFormat("journal is too large".to_owned()))?
                + 1;
            if entry.sequence != expected {
                return Err(JournalError::InvalidSequence {
                    expected,
                    actual: entry.sequence,
                });
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum JournalError {
    InvalidSequence { expected: u64, actual: u64 },
    InvalidFormat(String),
    InvalidEvent(String),
}

impl Display for JournalError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSequence { expected, actual } => {
                write!(
                    f,
                    "journal sequence mismatch: expected {expected}, found {actual}"
                )
            }
            Self::InvalidFormat(message) => write!(f, "invalid journal format: {message}"),
            Self::InvalidEvent(message) => write!(f, "invalid journal event: {message}"),
        }
    }
}

impl Error for JournalError {}

pub(crate) struct DurableProjection<'a> {
    pub config_revision: &'a ConfigRevisionId,
    pub sessions: &'a mut BTreeMap<SessionId, SessionRecord>,
    pub executions: &'a mut BTreeMap<ExecutionId, ExecutionRecord>,
    pub resolved_routes: &'a mut BTreeMap<ExecutionId, ResolvedRoute>,
    pub events: &'a mut Vec<ExecutionEvent>,
    pub next_session: &'a mut u64,
    pub next_execution: &'a mut u64,
    pub next_event: &'a mut u64,
    pub next_tool_call: &'a mut u64,
}

#[derive(Serialize)]
struct ConversationReplayMessage {
    role: &'static str,
    content: String,
}

struct AccumulatedMessage {
    execution_id: ExecutionId,
    role: &'static str,
    content: String,
}

fn materialize_execution_payload(
    state: &DurableProjection<'_>,
    execution: &ExecutionSummary,
    payload: &JournalExecutionPayload,
) -> ExecutionPayload {
    match payload {
        JournalExecutionPayload::Invocation { input }
            if execution.kind == ExecutionKind::Root
                && matches!(execution.target, ExecutionTarget::Routed(_)) =>
        {
            ExecutionPayload::Invocation {
                input: materialize_routed_input(state, execution, input),
            }
        }
        _ => payload.clone().into(),
    }
}

fn materialize_routed_input(
    state: &DurableProjection<'_>,
    execution: &ExecutionSummary,
    input: &str,
) -> String {
    let mut messages = Vec::<AccumulatedMessage>::new();

    for event in state.events.iter() {
        if event.session_id != execution.session_id || event.execution_id == execution.id {
            continue;
        }
        let Some(previous) = state.executions.get(&event.execution_id) else {
            continue;
        };
        if previous.summary.kind != ExecutionKind::Root
            || previous.summary.parent_execution.is_some()
        {
            continue;
        }

        match &event.kind {
            ExecutionEventKind::UserInput { text } => messages.push(AccumulatedMessage {
                execution_id: event.execution_id.clone(),
                role: "user",
                content: text.clone(),
            }),
            ExecutionEventKind::AssistantContentDelta { text } => {
                if let Some(last) = messages.last_mut().filter(|message| {
                    message.execution_id == event.execution_id && message.role == "assistant"
                }) {
                    last.content.push_str(text);
                } else {
                    messages.push(AccumulatedMessage {
                        execution_id: event.execution_id.clone(),
                        role: "assistant",
                        content: text.clone(),
                    });
                }
            }
            _ => {}
        }
    }

    if messages.is_empty() {
        return input.to_owned();
    }

    let replay = messages
        .into_iter()
        .map(|message| ConversationReplayMessage {
            role: message.role,
            content: message.content,
        })
        .collect::<Vec<_>>();
    let replay = serde_json::to_string(&replay)
        .expect("conversation replay contains only JSON-serializable strings");

    format!(
        "Continue the same Phenix conversation. The prior user/assistant messages are serialized as JSON in chronological order. Treat each entry according to its `role`, then answer the current user message.\n\nPrior conversation:\n{replay}\n\nCurrent user message:\n{input}"
    )
}

pub(crate) fn apply_domain_event(
    state: &mut DurableProjection<'_>,
    event: &DomainEvent,
) -> Result<(), JournalError> {
    match event {
        DomainEvent::SessionCreated { session } => {
            if session.config_revision != *state.config_revision {
                return Err(JournalError::InvalidEvent(format!(
                    "session {} uses config revision {}, expected {}",
                    session.id, session.config_revision, state.config_revision
                )));
            }
            if session.state != SessionState::Active {
                return Err(JournalError::InvalidEvent(format!(
                    "new session {} must start active",
                    session.id
                )));
            }
            let expected_id = SessionId::parse(format!("session-{}", *state.next_session + 1))
                .expect("generated session id");
            if session.id != expected_id {
                return Err(JournalError::InvalidEvent(format!(
                    "session identity cursor mismatch: expected {expected_id}, found {}",
                    session.id
                )));
            }
            if let Some(parent) = &session.parent_session {
                if !state.sessions.contains_key(parent) {
                    return Err(JournalError::InvalidEvent(format!(
                        "session {} references unknown parent {parent}",
                        session.id
                    )));
                }
            }
            match state.sessions.entry(session.id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(SessionRecord {
                        summary: session.clone(),
                    });
                }
                Entry::Occupied(_) => {
                    return Err(JournalError::InvalidEvent(format!(
                        "duplicate session id: {}",
                        session.id
                    )));
                }
            }
            *state.next_session += 1;
        }
        DomainEvent::SessionRenamed { session_id, name } => {
            let session = state.sessions.get_mut(session_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "rename references unknown session {session_id}"
                ))
            })?;
            if session.summary.state == SessionState::Closed {
                return Err(JournalError::InvalidEvent(format!(
                    "closed session {session_id} cannot be renamed"
                )));
            }
            session.summary.name = Some(name.clone());
        }
        DomainEvent::SessionTargetChanged { session_id, target } => {
            let session = state.sessions.get_mut(session_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "target change references unknown session {session_id}"
                ))
            })?;
            if session.summary.state == SessionState::Closed {
                return Err(JournalError::InvalidEvent(format!(
                    "closed session {session_id} cannot change target"
                )));
            }
            session.summary.default_target = target.clone();
        }
        DomainEvent::SessionClosed { session_id } => {
            let session = state.sessions.get_mut(session_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!("close references unknown session {session_id}"))
            })?;
            if session.summary.state == SessionState::Closed {
                return Err(JournalError::InvalidEvent(format!(
                    "session {session_id} was closed more than once"
                )));
            }
            if state.executions.values().any(|execution| {
                execution.summary.session_id == *session_id
                    && !is_terminal(&execution.summary.state)
            }) {
                return Err(JournalError::InvalidEvent(format!(
                    "session {session_id} cannot close with active executions"
                )));
            }
            session.summary.state = SessionState::Closed;
        }
        DomainEvent::ExecutionCreated { execution, payload } => {
            let session = state.sessions.get(&execution.session_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "execution {} references unknown session {}",
                    execution.id, execution.session_id
                ))
            })?;
            if session.summary.state == SessionState::Closed {
                return Err(JournalError::InvalidEvent(format!(
                    "execution {} references closed session {}",
                    execution.id, execution.session_id
                )));
            }
            let expected_id =
                ExecutionId::parse(format!("execution-{}", *state.next_execution + 1))
                    .expect("generated execution id");
            if execution.id != expected_id {
                return Err(JournalError::InvalidEvent(format!(
                    "execution identity cursor mismatch: expected {expected_id}, found {}",
                    execution.id
                )));
            }
            if let Some(parent) = &execution.parent_execution {
                if !state.executions.contains_key(parent) {
                    return Err(JournalError::InvalidEvent(format!(
                        "execution {} references unknown parent {parent}",
                        execution.id
                    )));
                }
            }
            let materialized_payload = materialize_execution_payload(state, execution, payload);
            match state.executions.entry(execution.id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(ExecutionRecord {
                        summary: execution.clone(),
                        payload: materialized_payload,
                    });
                }
                Entry::Occupied(_) => {
                    return Err(JournalError::InvalidEvent(format!(
                        "duplicate execution id: {}",
                        execution.id
                    )));
                }
            }
            *state.next_execution += 1;
        }
        DomainEvent::ExecutionStateChanged {
            execution_id,
            state: next,
        } => {
            let execution = state.executions.get_mut(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "state change references unknown execution {execution_id}"
                ))
            })?;
            if is_terminal(&execution.summary.state) {
                return Err(JournalError::InvalidEvent(format!(
                    "terminal execution {execution_id} cannot change state"
                )));
            }
            execution.summary.state = next.clone();
        }
        DomainEvent::OrchestrationAdvanced {
            execution_id,
            next_node,
        } => {
            let execution = state.executions.get_mut(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "orchestration advance references unknown execution {execution_id}"
                ))
            })?;
            let ExecutionPayload::Orchestration {
                next_node: current, ..
            } = &mut execution.payload
            else {
                return Err(JournalError::InvalidEvent(format!(
                    "orchestration advance references non-orchestration execution {execution_id}"
                )));
            };
            if *next_node != *current + 1 {
                return Err(JournalError::InvalidEvent(format!(
                    "orchestration {execution_id} advanced from {current} to {next_node}"
                )));
            }
            *current = *next_node;
        }
        DomainEvent::InvocationResolved {
            execution_id,
            route,
        } => {
            let execution = state.executions.get(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "resolved route references unknown execution {execution_id}"
                ))
            })?;
            if !matches!(&execution.payload, ExecutionPayload::Invocation { .. }) {
                return Err(JournalError::InvalidEvent(format!(
                    "resolved route references non-invocation execution {execution_id}"
                )));
            }
            if route.config_revision != *state.config_revision {
                return Err(JournalError::InvalidEvent(format!(
                    "resolved route for {execution_id} uses config revision {} instead of {}",
                    route.config_revision, state.config_revision
                )));
            }
            if route.requested_target != execution.summary.target {
                return Err(JournalError::InvalidEvent(format!(
                    "resolved route for {execution_id} does not match execution target"
                )));
            }
            if let ExecutionTarget::Fixed(expected) = &route.requested_target {
                if &route.model != expected {
                    return Err(JournalError::InvalidEvent(format!(
                        "resolved fixed route for {execution_id} does not match its requested model"
                    )));
                }
            }
            match state.resolved_routes.entry(execution_id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(route.clone());
                }
                Entry::Occupied(_) => {
                    return Err(JournalError::InvalidEvent(format!(
                        "execution {execution_id} was resolved more than once"
                    )));
                }
            }
        }
        DomainEvent::FrontendEvent { event } => {
            let expected = *state.next_event + 1;
            if event.sequence != expected {
                return Err(JournalError::InvalidEvent(format!(
                    "frontend event sequence mismatch: expected {expected}, found {}",
                    event.sequence
                )));
            }
            let execution = state.executions.get(&event.execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "frontend event {} references unknown execution {}",
                    event.sequence, event.execution_id
                ))
            })?;
            if execution.summary.session_id != event.session_id {
                return Err(JournalError::InvalidEvent(format!(
                    "frontend event {} session does not match execution {}",
                    event.sequence, event.execution_id
                )));
            }
            if let ExecutionEventKind::ToolCallStarted { tool_call_id, .. } = &event.kind {
                let expected_id =
                    ToolCallId::parse(format!("tool-call-{}", *state.next_tool_call + 1))
                        .expect("generated tool call id");
                if *tool_call_id != expected_id {
                    return Err(JournalError::InvalidEvent(format!(
                        "tool-call identity cursor mismatch: expected {expected_id}, found {tool_call_id}"
                    )));
                }
                *state.next_tool_call += 1;
            }
            state.events.push(event.clone());
            *state.next_event = event.sequence;
        }
    }
    Ok(())
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
