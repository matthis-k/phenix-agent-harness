use crate::{
    journal::{apply_domain_event, DurableProjection},
    ConductorRuntime, RuntimeJournal,
};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum PersistenceError {
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidJournal(String),
}

impl Display for PersistenceError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "persistence I/O error: {error}"),
            Self::Json(error) => write!(f, "invalid persistence JSON: {error}"),
            Self::InvalidJournal(message) => write!(f, "invalid runtime journal: {message}"),
        }
    }
}

impl Error for PersistenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Json(error) => Some(error),
            Self::InvalidJournal(_) => None,
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

    pub fn save(&self, journal: &RuntimeJournal) -> Result<(), PersistenceError> {
        journal
            .validate_structure()
            .map_err(|error| PersistenceError::InvalidJournal(error.to_string()))?;
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
            .ok_or_else(|| PersistenceError::InvalidJournal("state path has no file name".into()))?
            .to_string_lossy();
        let temporary = self
            .path
            .with_file_name(format!(".{file_name}.tmp-{}", std::process::id()));
        let bytes = serde_json::to_vec_pretty(journal)?;
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

    pub fn load(&self) -> Result<RuntimeJournal, PersistenceError> {
        let bytes = fs::read(&self.path)?;
        let journal = serde_json::from_slice::<RuntimeJournal>(&bytes)?;
        journal
            .validate_structure()
            .map_err(|error| PersistenceError::InvalidJournal(error.to_string()))?;
        Ok(journal)
    }
}

impl ConductorRuntime {
    #[must_use]
    pub fn journal(&self) -> &RuntimeJournal {
        &self.journal
    }

    pub fn restore(journal: RuntimeJournal) -> Result<Self, PersistenceError> {
        journal
            .validate_structure()
            .map_err(|error| PersistenceError::InvalidJournal(error.to_string()))?;

        let config_revision = journal.config_revision.clone();
        let mut runtime = Self::new();
        runtime.config_revision = config_revision.clone();
        runtime.journal = RuntimeJournal::new(config_revision);

        for entry in &journal.entries {
            let mut projection = DurableProjection {
                config_revision: &runtime.config_revision,
                sessions: &mut runtime.sessions,
                executions: &mut runtime.executions,
                attempt_groups: &mut runtime.attempt_groups,
                orchestration_nodes: &mut runtime.orchestration_nodes,
                resolved_routes: &mut runtime.resolved_routes,
                read_sets: &mut runtime.read_sets,
                events: &mut runtime.events,
                next_session: &mut runtime.next_session,
                next_execution: &mut runtime.next_execution,
                next_attempt_group: &mut runtime.next_attempt_group,
                next_event: &mut runtime.next_event,
                next_tool_call: &mut runtime.next_tool_call,
            };
            apply_domain_event(&mut projection, &entry.event)
                .map_err(|error| PersistenceError::InvalidJournal(error.to_string()))?;
        }

        if let Some(workspace_id) = runtime
            .sessions
            .values()
            .next()
            .map(|session| session.summary.workspace_id.clone())
        {
            runtime.workspace_id = workspace_id;
        }
        runtime.journal = journal;
        Ok(runtime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DomainEvent;
    use phenix_core::{
        BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
        ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
        OrchestrationDefinition, OrchestrationNode, OrchestrationNodeId, ProviderId,
        RoutingProfile, RoutingProfileId, SessionId, WorkspaceId,
    };
    use serde_json::json;
    use std::collections::BTreeMap;
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

    fn node(
        id: &str,
        callable: &str,
        depends_on: &[&str],
        objective: Option<&str>,
    ) -> OrchestrationNode {
        OrchestrationNode {
            id: OrchestrationNodeId::parse(id).unwrap(),
            callable: CallableId::parse(callable).unwrap(),
            depends_on: depends_on
                .iter()
                .map(|dependency| OrchestrationNodeId::parse(*dependency).unwrap())
                .collect(),
            objective: objective.map(str::to_owned),
        }
    }

    fn bind_workflow_config(runtime: &mut ConductorRuntime) {
        runtime
            .register_agent(phenix_core::AgentDefinition::new(
                descriptor("agent.first", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ))
            .unwrap();
        runtime
            .register_agent(phenix_core::AgentDefinition::new(
                descriptor("agent.second", CallableKind::Agent),
                phenix_core::ExecutionAuthority::read_only(),
            ))
            .unwrap();
        runtime
            .register_orchestration(OrchestrationDefinition {
                descriptor: descriptor("orchestration.test", CallableKind::Orchestration),
                nodes: vec![
                    node("first", "agent.first", &[], Some("first")),
                    node("second", "agent.second", &["first"], None),
                ],
            })
            .unwrap();
    }

    fn temporary_store() -> (JsonFileStore, PathBuf) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "phenix-conductor-journal-{}-{unique}.json",
            std::process::id()
        ));
        (JsonFileStore::new(&path), path)
    }

    #[test]
    fn file_roundtrip_replays_state_and_continues_monotonic_cursors() {
        let mut runtime = ConductorRuntime::new();
        bind_workflow_config(&mut runtime);
        let session = runtime.create_session(None, None, fixed()).unwrap();
        let root = runtime.submit(&session.id, "root").unwrap();
        let orchestration = runtime
            .start_orchestration(
                &root.id,
                &CallableId::parse("orchestration.test").unwrap(),
                "orchestration objective",
            )
            .unwrap();
        let before_snapshot = runtime.snapshot();
        let before_events = runtime.events_since(0);
        let cursor = before_snapshot.last_event_sequence;

        let (store, path) = temporary_store();
        store.save(runtime.journal()).unwrap();
        let journal = store.load().unwrap();
        fs::remove_file(&path).unwrap();

        let mut restored = ConductorRuntime::restore(journal).unwrap();
        assert_eq!(restored.snapshot(), before_snapshot);
        assert_eq!(restored.events_since(0), before_events);
        assert!(restored.callable_descriptors().is_empty());

        bind_workflow_config(&mut restored);
        let first_child = restored
            .snapshot()
            .executions
            .into_iter()
            .find(|execution| {
                execution.parent_execution.as_ref() == Some(&orchestration.id)
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
                .filter(|execution| execution.parent_execution.as_ref() == Some(&orchestration.id))
                .count(),
            2
        );
        let resumed_events = restored.events_since(cursor);
        assert!(!resumed_events.is_empty());
        assert_eq!(resumed_events[0].sequence, cursor + 1);
    }

    #[test]
    fn replay_preserves_workspace_binding_and_rejects_mixed_workspaces() {
        let mut runtime = ConductorRuntime::new();
        let workspace = WorkspaceId::parse("workspace:/repo").unwrap();
        runtime.bind_workspace(workspace.clone()).unwrap();
        runtime.create_session(None, None, fixed()).unwrap();
        runtime.create_session(None, None, fixed()).unwrap();

        let restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();
        assert!(restored
            .snapshot()
            .sessions
            .iter()
            .all(|session| session.workspace_id == workspace));

        let mut corrupted = runtime.journal().clone();
        let session = corrupted
            .entries
            .iter_mut()
            .filter_map(|entry| match &mut entry.event {
                DomainEvent::SessionCreated { session } => Some(session),
                _ => None,
            })
            .nth(1)
            .unwrap();
        session.workspace_id = WorkspaceId::parse("workspace:/other").unwrap();
        assert!(matches!(
            ConductorRuntime::restore(corrupted),
            Err(PersistenceError::InvalidJournal(_))
        ));
    }

    #[test]
    fn replay_preserves_resolved_routing_without_rebinding_router() {
        let mut runtime = ConductorRuntime::new();
        let profile = RoutingProfileId::parse("default").unwrap();
        let concrete = ModelTarget {
            backend: BackendId::parse("mock").unwrap(),
            provider: ProviderId::parse("mock").unwrap(),
            model: ModelId::parse("routed").unwrap(),
            inference: InferenceOptions::default(),
        };
        runtime
            .register_routing_profile(RoutingProfile {
                id: profile.clone(),
                default_target: concrete.clone(),
                callable_targets: BTreeMap::new(),
            })
            .unwrap();
        let session = runtime
            .create_session(None, None, ExecutionTarget::Routed(profile))
            .unwrap();
        let execution = runtime.submit(&session.id, "work").unwrap();
        runtime.resolve_invocation(&execution.id).unwrap();

        let mut restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();
        let resolved = restored.resolve_invocation(&execution.id).unwrap();
        assert_eq!(resolved.model, concrete);
    }

    #[test]
    fn replay_rejects_corrupted_fixed_resolution() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime.create_session(None, None, fixed()).unwrap();
        let execution = runtime.submit(&session.id, "work").unwrap();
        runtime.resolve_invocation(&execution.id).unwrap();
        let mut journal = runtime.journal().clone();
        let route = journal
            .entries
            .iter_mut()
            .find_map(|entry| match &mut entry.event {
                DomainEvent::InvocationResolved { route, .. } => Some(route),
                _ => None,
            })
            .expect("fixed invocation is resolved in the journal");
        route.model.model = ModelId::parse("corrupted").unwrap();

        assert!(matches!(
            ConductorRuntime::restore(journal),
            Err(PersistenceError::InvalidJournal(_))
        ));
    }

    #[test]
    fn replay_rejects_semantically_invalid_identity_cursor() {
        let mut runtime = ConductorRuntime::new();
        runtime.create_session(None, None, fixed()).unwrap();
        let mut journal = runtime.journal().clone();
        let DomainEvent::SessionCreated { session } = &mut journal.entries[0].event else {
            panic!("first event is session creation");
        };
        session.id = SessionId::parse("session-9").unwrap();

        assert!(matches!(
            ConductorRuntime::restore(journal),
            Err(PersistenceError::InvalidJournal(_))
        ));
    }
}
