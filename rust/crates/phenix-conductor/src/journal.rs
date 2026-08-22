use crate::{
    ConfigRevisionFingerprint, ConfigRevisionSlot, ExecutionPayload, ExecutionRecord, SessionRecord,
};
use phenix_core::{
    AttemptGroup, AttemptGroupId, ConfigRevisionId, ExecutionAuthority, ExecutionEvent,
    ExecutionEventKind, ExecutionId, ExecutionKind, ExecutionReadSet, ExecutionState,
    ExecutionSummary, ExecutionTarget, FailureAttemptSummary, FileObservation, FileVersion,
    FilesystemAuthority, ModelTarget, OrchestrationFailureDecision,
    OrchestrationFailureDecisionRecord, OrchestrationNodeId, SessionId, SessionState,
    SessionSummary, ToolCallId, WorkspaceId,
};
use serde::{Deserialize, Serialize};
use std::collections::{btree_map::Entry, BTreeMap};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::PathBuf;

pub const JOURNAL_FORMAT_VERSION: u64 = 4;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JournalExecutionPayload {
    Invocation {
        input: String,
        #[serde(default)]
        authority: ExecutionAuthority,
    },
    Orchestration {
        input: serde_json::Value,
        #[serde(default)]
        authority: ExecutionAuthority,
    },
}

impl JournalExecutionPayload {
    #[must_use]
    pub(crate) fn authority(&self) -> &ExecutionAuthority {
        match self {
            Self::Invocation { authority, .. } | Self::Orchestration { authority, .. } => authority,
        }
    }

    pub(crate) fn set_authority(&mut self, authority: ExecutionAuthority) {
        match self {
            Self::Invocation {
                authority: current, ..
            }
            | Self::Orchestration {
                authority: current, ..
            } => *current = authority,
        }
    }
}

impl From<&ExecutionPayload> for JournalExecutionPayload {
    fn from(value: &ExecutionPayload) -> Self {
        match value {
            ExecutionPayload::Invocation { input } => Self::Invocation {
                input: input.clone(),
                authority: ExecutionAuthority::read_only(),
            },
            ExecutionPayload::Orchestration { input } => Self::Orchestration {
                input: input.clone(),
                authority: ExecutionAuthority::read_only(),
            },
        }
    }
}

impl From<JournalExecutionPayload> for ExecutionPayload {
    fn from(value: JournalExecutionPayload) -> Self {
        match value {
            JournalExecutionPayload::Invocation { input, .. } => Self::Invocation { input },
            JournalExecutionPayload::Orchestration { input, .. } => Self::Orchestration { input },
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
    ConfigurationRevisionActivated {
        revision: ConfigRevisionId,
        fingerprint: ConfigRevisionFingerprint,
    },
    SessionCreated {
        session: SessionSummary,
    },
    SessionConfigRebased {
        session_id: SessionId,
        config_revision: ConfigRevisionId,
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
    RootSubmissionAccepted {
        session_id: SessionId,
        execution_id: ExecutionId,
        ingress_order: u64,
    },
    ExecutionStateChanged {
        execution_id: ExecutionId,
        state: ExecutionState,
    },
    AttemptGroupCreated {
        group: AttemptGroup,
    },
    AttemptFailureRecorded {
        group_id: AttemptGroupId,
        failure: FailureAttemptSummary,
    },
    AttemptRetryStarted {
        group_id: AttemptGroupId,
        execution_id: ExecutionId,
    },
    OrchestrationFailureInterfaceStarted {
        parent_execution: ExecutionId,
        failed_child: ExecutionId,
        interface_execution: ExecutionId,
    },
    OrchestrationDecisionMade {
        decision: OrchestrationFailureDecisionRecord,
    },
    OrchestrationNodeStarted {
        execution_id: ExecutionId,
        node_id: OrchestrationNodeId,
        child_execution_id: ExecutionId,
    },
    OrchestrationNodeInputBound {
        execution_id: ExecutionId,
        node_id: OrchestrationNodeId,
        input: serde_json::Value,
    },
    OrchestrationSynthesisStarted {
        execution_id: ExecutionId,
        interface_execution_id: ExecutionId,
    },
    ExecutionOutputRecorded {
        execution_id: ExecutionId,
        output: serde_json::Value,
    },
    InvocationResolved {
        execution_id: ExecutionId,
        route: ResolvedRoute,
    },
    WorkspaceCheckpointCaptured {
        execution_id: ExecutionId,
        workspace_id: WorkspaceId,
        #[serde(default)]
        files: BTreeMap<PathBuf, FileVersion>,
    },
    WorkspaceFileObserved {
        execution_id: ExecutionId,
        observation: FileObservation,
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
    pub config_fingerprint: ConfigRevisionFingerprint,
    pub entries: Vec<JournalEntry>,
}

impl RuntimeJournal {
    #[must_use]
    pub fn new(
        config_revision: ConfigRevisionId,
        config_fingerprint: ConfigRevisionFingerprint,
    ) -> Self {
        Self {
            format_version: JOURNAL_FORMAT_VERSION,
            config_revision,
            config_fingerprint,
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
    pub config_revisions: &'a mut BTreeMap<ConfigRevisionId, ConfigRevisionSlot>,
    pub current_config_revision: &'a mut ConfigRevisionId,
    pub sessions: &'a mut BTreeMap<SessionId, SessionRecord>,
    pub executions: &'a mut BTreeMap<ExecutionId, ExecutionRecord>,
    pub root_ingress: &'a mut BTreeMap<ExecutionId, u64>,
    pub next_root_ingress: &'a mut BTreeMap<SessionId, u64>,
    pub attempt_groups: &'a mut BTreeMap<AttemptGroupId, AttemptGroup>,
    pub orchestration_decisions: &'a mut BTreeMap<ExecutionId, OrchestrationFailureDecisionRecord>,
    pub orchestration_interfaces: &'a mut BTreeMap<ExecutionId, ExecutionId>,
    pub orchestration_nodes: &'a mut BTreeMap<ExecutionId, OrchestrationNodeId>,
    pub orchestration_node_inputs:
        &'a mut BTreeMap<(ExecutionId, OrchestrationNodeId), serde_json::Value>,
    pub orchestration_synthesis: &'a mut BTreeMap<ExecutionId, ExecutionId>,
    pub execution_outputs: &'a mut BTreeMap<ExecutionId, serde_json::Value>,
    pub resolved_routes: &'a mut BTreeMap<ExecutionId, ResolvedRoute>,
    pub read_sets: &'a mut BTreeMap<ExecutionId, ExecutionReadSet>,
    pub events: &'a mut Vec<ExecutionEvent>,
    pub next_config_revision: &'a mut u64,
    pub next_session: &'a mut u64,
    pub next_execution: &'a mut u64,
    pub next_attempt_group: &'a mut u64,
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
        JournalExecutionPayload::Invocation { input, .. }
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
        DomainEvent::ConfigurationRevisionActivated {
            revision,
            fingerprint,
        } => {
            let expected =
                ConfigRevisionId::parse(format!("config-{}", *state.next_config_revision + 1))
                    .expect("generated config revision id");
            if revision != &expected || state.config_revisions.contains_key(revision) {
                return Err(JournalError::InvalidEvent(format!(
                    "configuration revision activation expected {expected}, found {revision}"
                )));
            }
            state.config_revisions.insert(
                revision.clone(),
                ConfigRevisionSlot {
                    fingerprint: fingerprint.clone(),
                    configuration: None,
                },
            );
            *state.current_config_revision = revision.clone();
            *state.next_config_revision += 1;
        }
        DomainEvent::SessionCreated { session } => {
            if !state
                .config_revisions
                .contains_key(&session.config_revision)
            {
                return Err(JournalError::InvalidEvent(format!(
                    "session {} references unknown config revision {}",
                    session.id, session.config_revision
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
                let parent = state.sessions.get(parent).ok_or_else(|| {
                    JournalError::InvalidEvent(format!(
                        "session {} references unknown parent {parent}",
                        session.id
                    ))
                })?;
                if parent.summary.workspace_id != session.workspace_id {
                    return Err(JournalError::InvalidEvent(format!(
                        "session {} workspace {} does not match parent workspace {}",
                        session.id, session.workspace_id, parent.summary.workspace_id
                    )));
                }
            } else if let Some(existing) = state.sessions.values().next() {
                if existing.summary.workspace_id != session.workspace_id {
                    return Err(JournalError::InvalidEvent(format!(
                        "root session {} workspace {} does not match runtime workspace {}",
                        session.id, session.workspace_id, existing.summary.workspace_id
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
        DomainEvent::SessionConfigRebased {
            session_id,
            config_revision,
        } => {
            if !state.config_revisions.contains_key(config_revision) {
                return Err(JournalError::InvalidEvent(format!(
                    "session {session_id} rebase references unknown config revision {config_revision}"
                )));
            }
            let session = state.sessions.get_mut(session_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "rebase references unknown session {session_id}"
                ))
            })?;
            if session.summary.state == SessionState::Closed {
                return Err(JournalError::InvalidEvent(format!(
                    "closed session {session_id} cannot be rebased"
                )));
            }
            session.summary.config_revision = config_revision.clone();
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
            let mut config_revision = session.summary.config_revision.clone();
            if let Some(parent_id) = &execution.parent_execution {
                let parent = state.executions.get(parent_id).ok_or_else(|| {
                    JournalError::InvalidEvent(format!(
                        "execution {} references unknown parent {parent_id}",
                        execution.id
                    ))
                })?;
                config_revision = parent.config_revision.clone();
                if let Some(callable) = execution.callable.as_ref() {
                    if !parent.authority.callables.contains(callable) {
                        return Err(JournalError::InvalidEvent(format!(
            "execution {} callable {callable} is not delegated by parent {parent_id}",
            execution.id
        )));
                    }
                }
                if !parent.authority.permits(payload.authority()) {
                    return Err(JournalError::InvalidEvent(format!(
                        "execution {} authority exceeds parent {parent_id}",
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
                        authority: payload.authority().clone(),
                        config_revision,
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
        DomainEvent::RootSubmissionAccepted {
            session_id,
            execution_id,
            ingress_order,
        } => {
            let execution = state.executions.get(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "root ingress references unknown execution {execution_id}"
                ))
            })?;
            if execution.summary.session_id != *session_id
                || execution.summary.parent_execution.is_some()
                || execution.summary.state != ExecutionState::Pending
            {
                return Err(JournalError::InvalidEvent(format!(
                    "root ingress does not match pending root execution {execution_id}"
                )));
            }
            let expected = state
                .next_root_ingress
                .get(session_id)
                .copied()
                .unwrap_or(0)
                .saturating_add(1);
            if *ingress_order != expected {
                return Err(JournalError::InvalidEvent(format!(
                    "session {session_id} ingress order expected {expected}, found {ingress_order}"
                )));
            }
            if state
                .root_ingress
                .insert(execution_id.clone(), *ingress_order)
                .is_some()
            {
                return Err(JournalError::InvalidEvent(format!(
                    "root execution {execution_id} was accepted more than once"
                )));
            }
            state
                .next_root_ingress
                .insert(session_id.clone(), *ingress_order);
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
        DomainEvent::AttemptGroupCreated { group } => {
            let expected_id =
                AttemptGroupId::parse(format!("attempt-group-{}", *state.next_attempt_group + 1))
                    .expect("generated attempt group id");
            if group.id != expected_id {
                return Err(JournalError::InvalidEvent(format!(
                    "attempt group identity cursor mismatch: expected {expected_id}, found {}",
                    group.id
                )));
            }
            if group.attempts.len() != 1 || group.failures.len() != 1 {
                return Err(JournalError::InvalidEvent(format!(
                    "new attempt group {} must contain exactly one failed first attempt",
                    group.id
                )));
            }
            let first_execution_id = &group.attempts[0];
            let first_failure = &group.failures[0];
            if first_failure.execution_id != *first_execution_id || first_failure.attempt != 1 {
                return Err(JournalError::InvalidEvent(format!(
                    "attempt group {} has an invalid first failure",
                    group.id
                )));
            }
            let execution = state.executions.get(first_execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "attempt group {} references unknown execution {first_execution_id}",
                    group.id
                ))
            })?;
            if execution.summary.kind != ExecutionKind::Agent
                || execution.summary.state != ExecutionState::Failed
                || execution.summary.parent_execution.as_ref() != Some(&group.parent_execution)
                || execution.summary.callable.as_ref() != Some(&group.callable)
            {
                return Err(JournalError::InvalidEvent(format!(
                    "attempt group {} does not match its first failed agent execution",
                    group.id
                )));
            }
            if state
                .attempt_groups
                .values()
                .any(|existing| existing.contains_execution(first_execution_id))
            {
                return Err(JournalError::InvalidEvent(format!(
                    "execution {first_execution_id} belongs to more than one attempt group"
                )));
            }
            if state
                .attempt_groups
                .insert(group.id.clone(), group.clone())
                .is_some()
            {
                return Err(JournalError::InvalidEvent(format!(
                    "duplicate attempt group id: {}",
                    group.id
                )));
            }
            *state.next_attempt_group += 1;
        }
        DomainEvent::AttemptFailureRecorded { group_id, failure } => {
            let group = state.attempt_groups.get(group_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "attempt failure references unknown group {group_id}"
                ))
            })?;
            if group.latest_execution() != Some(&failure.execution_id) {
                return Err(JournalError::InvalidEvent(format!(
                    "attempt failure for {} is not the latest execution in group {group_id}",
                    failure.execution_id
                )));
            }
            let expected_attempt = group
                .attempt_for_execution(&failure.execution_id)
                .expect("latest execution belongs to its attempt group");
            if failure.attempt != expected_attempt {
                return Err(JournalError::InvalidEvent(format!(
                    "attempt failure for {} uses number {}, expected {expected_attempt}",
                    failure.execution_id, failure.attempt
                )));
            }
            if group
                .failures
                .iter()
                .any(|existing| existing.execution_id == failure.execution_id)
            {
                return Err(JournalError::InvalidEvent(format!(
                    "attempt failure for {} was recorded more than once",
                    failure.execution_id
                )));
            }
            let execution = state.executions.get(&failure.execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "attempt failure references unknown execution {}",
                    failure.execution_id
                ))
            })?;
            if execution.summary.state != ExecutionState::Failed {
                return Err(JournalError::InvalidEvent(format!(
                    "attempt failure references non-failed execution {}",
                    failure.execution_id
                )));
            }
            state
                .attempt_groups
                .get_mut(group_id)
                .expect("validated attempt group exists")
                .record_failure(failure.clone());
        }
        DomainEvent::AttemptRetryStarted {
            group_id,
            execution_id,
        } => {
            let group = state.attempt_groups.get(group_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "attempt retry references unknown group {group_id}"
                ))
            })?;
            let previous = group.latest_execution().ok_or_else(|| {
                JournalError::InvalidEvent(format!("attempt group {group_id} has no attempts"))
            })?;
            if !group
                .failures
                .iter()
                .any(|failure| &failure.execution_id == previous)
            {
                return Err(JournalError::InvalidEvent(format!(
                    "attempt group {group_id} retried before its latest execution failed"
                )));
            }
            if state
                .attempt_groups
                .values()
                .any(|existing| existing.contains_execution(execution_id))
            {
                return Err(JournalError::InvalidEvent(format!(
                    "execution {execution_id} belongs to more than one attempt group"
                )));
            }
            let execution = state.executions.get(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "attempt retry references unknown execution {execution_id}"
                ))
            })?;
            if execution.summary.kind != ExecutionKind::Agent
                || execution.summary.state != ExecutionState::Pending
                || execution.summary.parent_execution.as_ref() != Some(&group.parent_execution)
                || execution.summary.callable.as_ref() != Some(&group.callable)
            {
                return Err(JournalError::InvalidEvent(format!(
                    "retry execution {execution_id} does not match attempt group {group_id}"
                )));
            }
            state
                .attempt_groups
                .get_mut(group_id)
                .expect("validated attempt group exists")
                .record_retry(execution_id.clone());
        }
        DomainEvent::OrchestrationFailureInterfaceStarted {
            parent_execution,
            failed_child,
            interface_execution,
        } => {
            if state.orchestration_interfaces.contains_key(failed_child) {
                return Err(JournalError::InvalidEvent(format!(
                    "failed child {failed_child} received more than one interface execution"
                )));
            }
            let parent = state.executions.get(parent_execution).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "failure interface references unknown parent {parent_execution}"
                ))
            })?;
            let failed = state.executions.get(failed_child).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "failure interface references unknown failed child {failed_child}"
                ))
            })?;
            let interface = state.executions.get(interface_execution).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "failure interface references unknown execution {interface_execution}"
                ))
            })?;
            let expected_latest =
                ExecutionId::parse(format!("execution-{}", *state.next_execution))
                    .expect("generated execution id");
            if parent.summary.kind != ExecutionKind::Orchestration
                || parent.summary.state != ExecutionState::Running
                || failed.summary.parent_execution.as_ref() != Some(parent_execution)
                || failed.summary.kind != ExecutionKind::Agent
                || failed.summary.state != ExecutionState::Failed
                || interface.summary.parent_execution.as_ref() != Some(parent_execution)
                || interface.summary.kind != ExecutionKind::Agent
                || interface.summary.state != ExecutionState::Pending
                || *interface_execution != expected_latest
                || state.orchestration_nodes.contains_key(interface_execution)
            {
                return Err(JournalError::InvalidEvent(format!(
                    "invalid failure interface binding for child {failed_child}"
                )));
            }
            state
                .orchestration_interfaces
                .insert(failed_child.clone(), interface_execution.clone());
        }
        DomainEvent::OrchestrationDecisionMade { decision } => {
            if state
                .orchestration_decisions
                .contains_key(&decision.failed_child)
            {
                return Err(JournalError::InvalidEvent(format!(
                    "child {} received more than one orchestration failure decision",
                    decision.failed_child
                )));
            }
            let parent = state
                .executions
                .get(&decision.parent_execution)
                .ok_or_else(|| {
                    JournalError::InvalidEvent(format!(
                        "orchestration decision references unknown parent {}",
                        decision.parent_execution
                    ))
                })?;
            let failed = state
                .executions
                .get(&decision.failed_child)
                .ok_or_else(|| {
                    JournalError::InvalidEvent(format!(
                        "orchestration decision references unknown failed child {}",
                        decision.failed_child
                    ))
                })?;
            if parent.summary.kind != ExecutionKind::Orchestration
                || parent.summary.state != ExecutionState::Running
                || failed.summary.parent_execution.as_ref() != Some(&decision.parent_execution)
                || failed.summary.kind != ExecutionKind::Agent
                || failed.summary.state != ExecutionState::Failed
            {
                return Err(JournalError::InvalidEvent(format!(
                    "invalid orchestration decision relation for child {}",
                    decision.failed_child
                )));
            }
            match decision.decider_execution.as_ref() {
                Some(decider_id) => {
                    if state.orchestration_interfaces.get(&decision.failed_child)
                        != Some(decider_id)
                    {
                        return Err(JournalError::InvalidEvent(format!(
                            "orchestration decision decider {decider_id} is not bound to failed child {}",
                            decision.failed_child
                        )));
                    }
                    let decider = state.executions.get(decider_id).ok_or_else(|| {
                        JournalError::InvalidEvent(format!(
                            "orchestration decision references unknown decider {decider_id}"
                        ))
                    })?;
                    if decider.summary.parent_execution.as_ref() != Some(&decision.parent_execution)
                        || decider.summary.kind != ExecutionKind::Agent
                        || !matches!(
                            decider.summary.state,
                            ExecutionState::Running | ExecutionState::Completed
                        )
                    {
                        return Err(JournalError::InvalidEvent(format!(
                            "orchestration decision decider {decider_id} is not an active interface agent"
                        )));
                    }
                }
                None if !matches!(decision.decision, OrchestrationFailureDecision::Fail) => {
                    return Err(JournalError::InvalidEvent(
                        "only fail decisions may omit a decider execution".to_owned(),
                    ));
                }
                None => {}
            }
            if let Some(recovery_id) = decision.decision.recovery_execution() {
                let expected_latest =
                    ExecutionId::parse(format!("execution-{}", *state.next_execution))
                        .expect("generated execution id");
                let recovery = state.executions.get(recovery_id).ok_or_else(|| {
                    JournalError::InvalidEvent(format!(
                        "orchestration decision references unknown recovery execution {recovery_id}"
                    ))
                })?;
                if *recovery_id != expected_latest
                    || recovery.summary.parent_execution.as_ref()
                        != Some(&decision.parent_execution)
                    || recovery.summary.kind != ExecutionKind::Agent
                    || recovery.summary.state != ExecutionState::Pending
                    || state.orchestration_nodes.contains_key(recovery_id)
                    || state
                        .orchestration_interfaces
                        .values()
                        .any(|id| id == recovery_id)
                    || state
                        .orchestration_decisions
                        .values()
                        .any(|existing| existing.decision.recovery_execution() == Some(recovery_id))
                {
                    return Err(JournalError::InvalidEvent(format!(
                        "orchestration recovery {recovery_id} is not a fresh pending recovery child"
                    )));
                }
            }
            match &decision.decision {
                OrchestrationFailureDecision::Retry { execution_id } => {
                    let group = state
                        .attempt_groups
                        .values()
                        .find(|group| {
                            group.contains_execution(&decision.failed_child)
                                && group.contains_execution(execution_id)
                        })
                        .ok_or_else(|| {
                            JournalError::InvalidEvent(format!(
                                "retry decision for {} is not backed by one attempt group",
                                decision.failed_child
                            ))
                        })?;
                    if group.latest_execution() != Some(execution_id) {
                        return Err(JournalError::InvalidEvent(format!(
                            "retry decision recovery {execution_id} is not the latest attempt"
                        )));
                    }
                }
                OrchestrationFailureDecision::ChooseAnotherChild { execution_id } => {
                    let recovery = state
                        .executions
                        .get(execution_id)
                        .expect("recovery reference validated above");
                    if recovery.summary.callable == failed.summary.callable {
                        return Err(JournalError::InvalidEvent(format!(
                            "replacement decision for {} reuses the failed callable",
                            decision.failed_child
                        )));
                    }
                }
                OrchestrationFailureDecision::Continue | OrchestrationFailureDecision::Fail => {}
            }
            state
                .orchestration_decisions
                .insert(decision.failed_child.clone(), decision.clone());
        }
        DomainEvent::OrchestrationNodeStarted {
            execution_id,
            node_id,
            child_execution_id,
        } => {
            let orchestration = state.executions.get(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "orchestration node references unknown execution {execution_id}"
                ))
            })?;
            if orchestration.summary.kind != ExecutionKind::Orchestration {
                return Err(JournalError::InvalidEvent(format!(
                    "orchestration node references non-orchestration execution {execution_id}"
                )));
            }
            let child = state.executions.get(child_execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "orchestration node {node_id} references unknown child {child_execution_id}"
                ))
            })?;
            if child.summary.parent_execution.as_ref() != Some(execution_id) {
                return Err(JournalError::InvalidEvent(format!(
                    "orchestration node {node_id} child {child_execution_id} has the wrong parent"
                )));
            }
            if state
                .orchestration_nodes
                .iter()
                .any(|(child_id, existing_node)| {
                    existing_node == node_id
                        && state
                            .executions
                            .get(child_id)
                            .and_then(|execution| execution.summary.parent_execution.as_ref())
                            == Some(execution_id)
                })
            {
                return Err(JournalError::InvalidEvent(format!(
                    "orchestration {execution_id} started node {node_id} more than once"
                )));
            }
            match state.orchestration_nodes.entry(child_execution_id.clone()) {
                Entry::Vacant(entry) => {
                    entry.insert(node_id.clone());
                }
                Entry::Occupied(_) => {
                    return Err(JournalError::InvalidEvent(format!(
                        "child execution {child_execution_id} was assigned to more than one orchestration node"
                    )));
                }
            }
        }
        DomainEvent::OrchestrationNodeInputBound {
            execution_id,
            node_id,
            input,
        } => {
            let child_exists = state
                .orchestration_nodes
                .iter()
                .any(|(child_id, bound_node)| {
                    bound_node == node_id
                        && state
                            .executions
                            .get(child_id)
                            .and_then(|execution| execution.summary.parent_execution.as_ref())
                            == Some(execution_id)
                });
            if !child_exists {
                return Err(JournalError::InvalidEvent(format!(
                    "orchestration {execution_id} input binding references unstarted node {node_id}"
                )));
            }
            if state
                .orchestration_node_inputs
                .insert((execution_id.clone(), node_id.clone()), input.clone())
                .is_some()
            {
                return Err(JournalError::InvalidEvent(format!(
                    "orchestration {execution_id} node {node_id} input was bound more than once"
                )));
            }
        }
        DomainEvent::OrchestrationSynthesisStarted {
            execution_id,
            interface_execution_id,
        } => {
            let orchestration = state.executions.get(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "synthesis references unknown orchestration {execution_id}"
                ))
            })?;
            let interface = state
                .executions
                .get(interface_execution_id)
                .ok_or_else(|| {
                    JournalError::InvalidEvent(format!(
                        "synthesis references unknown interface execution {interface_execution_id}"
                    ))
                })?;
            if orchestration.summary.kind != ExecutionKind::Orchestration
                || interface.summary.parent_execution.as_ref() != Some(execution_id)
            {
                return Err(JournalError::InvalidEvent(format!(
                    "invalid synthesis binding {execution_id} -> {interface_execution_id}"
                )));
            }
            if state
                .orchestration_synthesis
                .insert(execution_id.clone(), interface_execution_id.clone())
                .is_some()
            {
                return Err(JournalError::InvalidEvent(format!(
                    "orchestration {execution_id} started synthesis more than once"
                )));
            }
        }
        DomainEvent::ExecutionOutputRecorded {
            execution_id,
            output,
        } => {
            if !state.executions.contains_key(execution_id) {
                return Err(JournalError::InvalidEvent(format!(
                    "output references unknown execution {execution_id}"
                )));
            }
            if state
                .execution_outputs
                .insert(execution_id.clone(), output.clone())
                .is_some()
            {
                return Err(JournalError::InvalidEvent(format!(
                    "execution {execution_id} output was recorded more than once"
                )));
            }
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
            if route.config_revision != execution.config_revision {
                return Err(JournalError::InvalidEvent(format!(
                    "resolved route for {execution_id} uses config revision {} instead of pinned {}",
                    route.config_revision, execution.config_revision
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
        DomainEvent::WorkspaceCheckpointCaptured {
            execution_id,
            workspace_id,
            files: _,
        } => {
            let execution = state.executions.get(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "workspace checkpoint references unknown execution {execution_id}"
                ))
            })?;
            if execution.summary.state != ExecutionState::Pending {
                return Err(JournalError::InvalidEvent(format!(
                    "workspace checkpoint references non-pending execution {execution_id}"
                )));
            }
            if execution.authority.filesystem != FilesystemAuthority::Write {
                return Err(JournalError::InvalidEvent(format!(
                    "workspace checkpoint references non-writer execution {execution_id}"
                )));
            }
            let session = state
                .sessions
                .get(&execution.summary.session_id)
                .ok_or_else(|| {
                    JournalError::InvalidEvent(format!(
                        "workspace checkpoint execution {execution_id} references unknown session {}",
                        execution.summary.session_id
                    ))
                })?;
            if session.summary.workspace_id != *workspace_id {
                return Err(JournalError::InvalidEvent(format!(
                    "workspace checkpoint for {execution_id} uses workspace {workspace_id} instead of {}",
                    session.summary.workspace_id
                )));
            }
        }
        DomainEvent::WorkspaceFileObserved {
            execution_id,
            observation,
        } => {
            let execution = state.executions.get(execution_id).ok_or_else(|| {
                JournalError::InvalidEvent(format!(
                    "workspace observation references unknown execution {execution_id}"
                ))
            })?;
            if execution.summary.state != ExecutionState::Running {
                return Err(JournalError::InvalidEvent(format!(
                    "workspace observation references non-running execution {execution_id}"
                )));
            }
            state
                .read_sets
                .entry(execution_id.clone())
                .or_insert_with(|| ExecutionReadSet::new(execution_id.clone()))
                .observe(observation.clone());
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn orchestration_payload_serializes_typed_input() {
        let payload: JournalExecutionPayload = serde_json::from_value(json!({
            "kind": "orchestration",
            "input": {"goal": "implement"}
        }))
        .unwrap();
        assert!(matches!(
            payload,
            JournalExecutionPayload::Orchestration {
                ref input,
                ..
            } if input == &json!({"goal": "implement"})
        ));
        assert_eq!(payload.authority(), &ExecutionAuthority::read_only());
        assert_eq!(
            serde_json::to_value(&payload).unwrap()["kind"],
            "orchestration"
        );
    }
}
