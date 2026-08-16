use crate::{
    CallableRegistry, ConductorRuntime, ExecutionPayload, ExecutionRecord, RoutingRegistry,
    SessionRecord,
};
use phenix_core::{
    ConfigRevisionId, ExecutionEvent, ExecutionId, ExecutionSummary, SessionId, SessionSummary,
};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const CHECKPOINT_FORMAT_VERSION: u64 = 1;

#[derive(Clone, Debug, PartialEq)]
enum PersistedExecutionPayload {
    Model { prompt: String },
    Workflow { objective: String, next_step: usize },
}

impl From<&ExecutionPayload> for PersistedExecutionPayload {
    fn from(value: &ExecutionPayload) -> Self {
        match value {
            ExecutionPayload::Model { prompt } => Self::Model {
                prompt: prompt.clone(),
            },
            ExecutionPayload::Workflow {
                objective,
                next_step,
            } => Self::Workflow {
                objective: objective.clone(),
                next_step: *next_step,
            },
        }
    }
}

impl From<PersistedExecutionPayload> for ExecutionPayload {
    fn from(value: PersistedExecutionPayload) -> Self {
        match value {
            PersistedExecutionPayload::Model { prompt } => Self::Model { prompt },
            PersistedExecutionPayload::Workflow {
                objective,
                next_step,
            } => Self::Workflow {
                objective,
                next_step,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct PersistedExecution {
    summary: ExecutionSummary,
    payload: PersistedExecutionPayload,
}

impl PersistedExecution {
    fn to_value(&self) -> Result<Value, PersistenceError> {
        let summary = serde_json::to_value(&self.summary)?;
        let payload = match &self.payload {
            PersistedExecutionPayload::Model { prompt } => json!({
                "kind": "model",
                "prompt": prompt,
            }),
            PersistedExecutionPayload::Workflow {
                objective,
                next_step,
            } => json!({
                "kind": "workflow",
                "objective": objective,
                "next_step": next_step,
            }),
        };
        Ok(json!({
            "summary": summary,
            "payload": payload,
        }))
    }

    fn from_value(value: &Value) -> Result<Self, PersistenceError> {
        let object = expect_object(value, "execution")?;
        let summary = serde_json::from_value(required(object, "summary")?.clone())?;
        let payload = expect_object(required(object, "payload")?, "execution payload")?;
        let kind = required(payload, "kind")?.as_str().ok_or_else(|| {
            PersistenceError::InvalidFormat("payload kind must be a string".into())
        })?;
        let payload = match kind {
            "model" => PersistedExecutionPayload::Model {
                prompt: required(payload, "prompt")?
                    .as_str()
                    .ok_or_else(|| {
                        PersistenceError::InvalidFormat("model prompt must be a string".into())
                    })?
                    .to_owned(),
            },
            "workflow" => PersistedExecutionPayload::Workflow {
                objective: required(payload, "objective")?
                    .as_str()
                    .ok_or_else(|| {
                        PersistenceError::InvalidFormat(
                            "workflow objective must be a string".into(),
                        )
                    })?
                    .to_owned(),
                next_step: usize::try_from(required_u64(payload, "next_step")?).map_err(|_| {
                    PersistenceError::InvalidFormat("workflow next_step exceeds usize".into())
                })?,
            },
            other => {
                return Err(PersistenceError::InvalidFormat(format!(
                    "unknown execution payload kind: {other}"
                )))
            }
        };
        Ok(Self { summary, payload })
    }
}

/// Durable mutable conductor state. Executable callables, routing tables,
/// invocation guards, and backend sessions are intentionally excluded and must
/// be rebound from the pinned immutable config revision after restore.
#[derive(Clone, Debug, PartialEq)]
pub struct RuntimeCheckpoint {
    config_revision: ConfigRevisionId,
    sessions: Vec<SessionSummary>,
    executions: Vec<PersistedExecution>,
    events: Vec<ExecutionEvent>,
    next_session: u64,
    next_execution: u64,
    next_event: u64,
    next_tool_call: u64,
}

impl RuntimeCheckpoint {
    #[must_use]
    pub fn config_revision(&self) -> &ConfigRevisionId {
        &self.config_revision
    }

    #[must_use]
    pub fn last_event_sequence(&self) -> u64 {
        self.next_event
    }

    fn to_value(&self) -> Result<Value, PersistenceError> {
        let config_revision = serde_json::to_value(&self.config_revision)?;
        let sessions = serde_json::to_value(&self.sessions)?;
        let executions = Value::Array(
            self.executions
                .iter()
                .map(PersistedExecution::to_value)
                .collect::<Result<Vec<_>, _>>()?,
        );
        let events = serde_json::to_value(&self.events)?;
        Ok(json!({
            "format_version": CHECKPOINT_FORMAT_VERSION,
            "config_revision": config_revision,
            "sessions": sessions,
            "executions": executions,
            "events": events,
            "counters": {
                "session": self.next_session,
                "execution": self.next_execution,
                "event": self.next_event,
                "tool_call": self.next_tool_call,
            }
        }))
    }

    fn from_value(value: Value) -> Result<Self, PersistenceError> {
        let object = expect_object(&value, "checkpoint")?;
        let version = required_u64(object, "format_version")?;
        if version != CHECKPOINT_FORMAT_VERSION {
            return Err(PersistenceError::InvalidFormat(format!(
                "unsupported checkpoint format version: {version}"
            )));
        }
        let config_revision = serde_json::from_value(required(object, "config_revision")?.clone())?;
        let sessions = serde_json::from_value(required(object, "sessions")?.clone())?;
        let execution_values = required(object, "executions")?
            .as_array()
            .ok_or_else(|| PersistenceError::InvalidFormat("executions must be an array".into()))?;
        let executions = execution_values
            .iter()
            .map(PersistedExecution::from_value)
            .collect::<Result<Vec<_>, _>>()?;
        let events = serde_json::from_value(required(object, "events")?.clone())?;
        let counters = expect_object(required(object, "counters")?, "counters")?;
        let checkpoint = Self {
            config_revision,
            sessions,
            executions,
            events,
            next_session: required_u64(counters, "session")?,
            next_execution: required_u64(counters, "execution")?,
            next_event: required_u64(counters, "event")?,
            next_tool_call: required_u64(counters, "tool_call")?,
        };
        checkpoint.validate()?;
        Ok(checkpoint)
    }

    fn validate(&self) -> Result<(), PersistenceError> {
        let mut session_ids = BTreeSet::new();
        for session in &self.sessions {
            if !session_ids.insert(session.id.clone()) {
                return Err(PersistenceError::InvalidFormat(format!(
                    "duplicate session id: {}",
                    session.id
                )));
            }
        }
        for session in &self.sessions {
            if let Some(parent) = &session.parent_session {
                if !session_ids.contains(parent) {
                    return Err(PersistenceError::InvalidFormat(format!(
                        "session {} references unknown parent {parent}",
                        session.id
                    )));
                }
            }
        }

        let mut execution_ids = BTreeSet::new();
        for execution in &self.executions {
            if !session_ids.contains(&execution.summary.session_id) {
                return Err(PersistenceError::InvalidFormat(format!(
                    "execution {} references unknown session {}",
                    execution.summary.id, execution.summary.session_id
                )));
            }
            if !execution_ids.insert(execution.summary.id.clone()) {
                return Err(PersistenceError::InvalidFormat(format!(
                    "duplicate execution id: {}",
                    execution.summary.id
                )));
            }
        }
        for execution in &self.executions {
            if let Some(parent) = &execution.summary.parent_execution {
                if !execution_ids.contains(parent) {
                    return Err(PersistenceError::InvalidFormat(format!(
                        "execution {} references unknown parent {parent}",
                        execution.summary.id
                    )));
                }
            }
        }

        for (index, event) in self.events.iter().enumerate() {
            let expected = u64::try_from(index)
                .map_err(|_| PersistenceError::InvalidFormat("event log too large".into()))?
                + 1;
            if event.sequence != expected {
                return Err(PersistenceError::InvalidFormat(format!(
                    "event sequence gap: expected {expected}, found {}",
                    event.sequence
                )));
            }
            if !session_ids.contains(&event.session_id) {
                return Err(PersistenceError::InvalidFormat(format!(
                    "event {} references unknown session {}",
                    event.sequence, event.session_id
                )));
            }
            if !execution_ids.contains(&event.execution_id) {
                return Err(PersistenceError::InvalidFormat(format!(
                    "event {} references unknown execution {}",
                    event.sequence, event.execution_id
                )));
            }
        }
        let last_event = self.events.last().map_or(0, |event| event.sequence);
        if self.next_event != last_event {
            return Err(PersistenceError::InvalidFormat(format!(
                "event counter {} does not match log tail {last_event}",
                self.next_event
            )));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub enum PersistenceError {
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidFormat(String),
}

impl Display for PersistenceError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "persistence I/O error: {error}"),
            Self::Json(error) => write!(f, "invalid persistence JSON: {error}"),
            Self::InvalidFormat(message) => write!(f, "invalid checkpoint: {message}"),
        }
    }
}

impl Error for PersistenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::InvalidFormat(_) => None,
        }
    }
}

impl From<std::io::Error> for PersistenceError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for PersistenceError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Clone, Debug)]
pub struct JsonFileStore {
    path: PathBuf,
}

impl JsonFileStore {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn save(&self, checkpoint: &RuntimeCheckpoint) -> Result<(), PersistenceError> {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }
        let file_name = self
            .path
            .file_name()
            .ok_or_else(|| PersistenceError::InvalidFormat("state path has no file name".into()))?
            .to_string_lossy();
        let temporary = self
            .path
            .with_file_name(format!(".{file_name}.tmp-{}", std::process::id()));
        let bytes = serde_json::to_vec_pretty(&checkpoint.to_value()?)?;
        let result = (|| -> Result<(), PersistenceError> {
            let mut file = OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn load(&self) -> Result<RuntimeCheckpoint, PersistenceError> {
        let bytes = fs::read(&self.path)?;
        RuntimeCheckpoint::from_value(serde_json::from_slice(&bytes)?)
    }
}

impl ConductorRuntime {
    #[must_use]
    pub fn checkpoint(&self) -> RuntimeCheckpoint {
        RuntimeCheckpoint {
            config_revision: self.config_revision.clone(),
            sessions: self
                .sessions
                .values()
                .map(|record| record.summary.clone())
                .collect(),
            executions: self
                .executions
                .values()
                .map(|record| PersistedExecution {
                    summary: record.summary.clone(),
                    payload: PersistedExecutionPayload::from(&record.payload),
                })
                .collect(),
            events: self.events.clone(),
            next_session: self.next_session,
            next_execution: self.next_execution,
            next_event: self.next_event,
            next_tool_call: self.next_tool_call,
        }
    }

    pub fn restore(checkpoint: RuntimeCheckpoint) -> Result<Self, PersistenceError> {
        checkpoint.validate()?;
        let sessions = checkpoint
            .sessions
            .into_iter()
            .map(|summary| (summary.id.clone(), SessionRecord { summary }))
            .collect::<BTreeMap<SessionId, SessionRecord>>();
        let executions = checkpoint
            .executions
            .into_iter()
            .map(|execution| {
                (
                    execution.summary.id.clone(),
                    ExecutionRecord {
                        summary: execution.summary,
                        payload: execution.payload.into(),
                    },
                )
            })
            .collect::<BTreeMap<ExecutionId, ExecutionRecord>>();
        Ok(Self {
            config_revision: checkpoint.config_revision,
            sessions,
            executions,
            events: checkpoint.events,
            callables: CallableRegistry::default(),
            routing: RoutingRegistry::default(),
            policy: crate::InvocationPolicy::new(),
            event_sink: None,
            next_session: checkpoint.next_session,
            next_execution: checkpoint.next_execution,
            next_event: checkpoint.next_event,
            next_tool_call: checkpoint.next_tool_call,
        })
    }
}

fn expect_object<'a>(
    value: &'a Value,
    context: &str,
) -> Result<&'a Map<String, Value>, PersistenceError> {
    value
        .as_object()
        .ok_or_else(|| PersistenceError::InvalidFormat(format!("{context} must be an object")))
}

fn required<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a Value, PersistenceError> {
    object
        .get(field)
        .ok_or_else(|| PersistenceError::InvalidFormat(format!("missing field: {field}")))
}

fn required_u64(object: &Map<String, Value>, field: &str) -> Result<u64, PersistenceError> {
    required(object, field)?.as_u64().ok_or_else(|| {
        PersistenceError::InvalidFormat(format!("{field} must be an unsigned integer"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use phenix_core::{
        BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
        ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
        ProviderId, WorkflowDefinition, WorkflowExecutionPolicy, WorkflowStep,
    };
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixed() -> ExecutionTarget {
        ExecutionTarget::Fixed(ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse("model").unwrap(),
            inference: InferenceOptions::default(),
        })
    }

    fn descriptor(id: &str, kind: CallableKind) -> CallableDescriptor {
        CallableDescriptor {
            id: CallableId::parse(id).unwrap(),
            kind,
            description: "test callable".to_owned(),
            input_schema: json!({"type": "object"}),
            output_schema: json!({"type": "object"}),
            capabilities: CapabilitySet::default(),
            policy: CallablePolicy::default(),
        }
    }

    fn bind_workflow_config(runtime: &mut ConductorRuntime) {
        runtime
            .register_agent(descriptor("agent.first", CallableKind::Agent))
            .unwrap();
        runtime
            .register_agent(descriptor("agent.second", CallableKind::Agent))
            .unwrap();
        runtime
            .register_workflow(WorkflowDefinition {
                descriptor: descriptor("workflow.test", CallableKind::Workflow),
                policy: WorkflowExecutionPolicy::Sequential,
                steps: vec![
                    WorkflowStep {
                        callable: CallableId::parse("agent.first").unwrap(),
                        objective: Some("first".to_owned()),
                    },
                    WorkflowStep {
                        callable: CallableId::parse("agent.second").unwrap(),
                        objective: None,
                    },
                ],
            })
            .unwrap();
    }

    #[test]
    fn file_roundtrip_restores_snapshot_events_and_monotonic_cursor() {
        let mut runtime = ConductorRuntime::new();
        bind_workflow_config(&mut runtime);
        let session = runtime.create_session(None, None, fixed()).unwrap();
        let root = runtime.submit(&session.id, "root").unwrap();
        let workflow = runtime
            .start_workflow(
                &root.id,
                &CallableId::parse("workflow.test").unwrap(),
                "workflow objective",
            )
            .unwrap();
        let before_snapshot = runtime.snapshot();
        let before_events = runtime.events_since(0);
        let cursor = runtime.checkpoint().last_event_sequence();

        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "phenix-conductor-checkpoint-{}-{unique}.json",
            std::process::id()
        ));
        let store = JsonFileStore::new(&path);
        store.save(&runtime.checkpoint()).unwrap();
        let checkpoint = store.load().unwrap();
        fs::remove_file(&path).unwrap();

        let mut restored = ConductorRuntime::restore(checkpoint).unwrap();
        assert_eq!(restored.snapshot(), before_snapshot);
        assert_eq!(restored.events_since(0), before_events);
        assert!(restored.callable_descriptors().is_empty());

        bind_workflow_config(&mut restored);
        let first_child = restored
            .snapshot()
            .executions
            .into_iter()
            .find(|execution| {
                execution.parent_execution.as_ref() == Some(&workflow.id)
                    && execution.kind == ExecutionKind::Agent
                    && execution.state == ExecutionState::Pending
            })
            .unwrap();
        restored
            .set_state(&first_child.id, ExecutionState::Completed)
            .unwrap();

        let snapshot = restored.snapshot();
        assert_eq!(
            snapshot
                .executions
                .iter()
                .filter(|execution| execution.parent_execution.as_ref() == Some(&workflow.id))
                .count(),
            2
        );
        let resumed_events = restored.events_since(cursor);
        assert!(!resumed_events.is_empty());
        assert_eq!(resumed_events[0].sequence, cursor + 1);
    }

    #[test]
    fn rejects_event_cursor_that_does_not_match_log_tail() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime.create_session(None, None, fixed()).unwrap();
        runtime.submit(&session.id, "root").unwrap();
        let mut checkpoint = runtime.checkpoint();
        checkpoint.next_event += 1;
        assert!(matches!(
            ConductorRuntime::restore(checkpoint),
            Err(PersistenceError::InvalidFormat(_))
        ));
    }
}
