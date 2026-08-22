use crate::{
    journal::{apply_domain_event, DurableProjection},
    ConductorRuntime, ConfigRevisionSlot, DomainEvent, RuntimeJournal,
};
use phenix_core::ExecutionEventKind;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::path::{Path, PathBuf};

const DATABASE_SCHEMA_VERSION: i64 = 2;

#[derive(Debug)]
pub enum PersistenceError {
    Io(std::io::Error),
    Sql(rusqlite::Error),
    Json(serde_json::Error),
    InvalidJournal(String),
}

impl Display for PersistenceError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "persistence I/O error: {error}"),
            Self::Sql(error) => write!(f, "SQLite persistence error: {error}"),
            Self::Json(error) => write!(f, "invalid persistence JSON: {error}"),
            Self::InvalidJournal(message) => write!(f, "invalid runtime journal: {message}"),
        }
    }
}

impl Error for PersistenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Sql(error) => Some(error),
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

impl From<rusqlite::Error> for PersistenceError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sql(value)
    }
}

#[derive(Clone, Debug)]
pub struct SqliteStore {
    path: PathBuf,
}

impl SqliteStore {
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn open(&self) -> Result<Connection, PersistenceError> {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&self.path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        migrate(&connection)?;
        Ok(connection)
    }

    pub fn save(&self, journal: &RuntimeJournal) -> Result<(), PersistenceError> {
        journal
            .validate_structure()
            .map_err(|error| PersistenceError::InvalidJournal(error.to_string()))?;
        let mut connection = self.open()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        initialize_or_validate_database(&transaction, journal)?;

        let stored_count =
            transaction.query_row("SELECT COUNT(*) FROM domain_events", [], |row| {
                row.get::<_, i64>(0)
            })?;
        let incoming_count = i64::try_from(journal.entries.len())
            .map_err(|_| PersistenceError::InvalidJournal("journal is too large".to_owned()))?;
        if stored_count > incoming_count {
            return Err(PersistenceError::InvalidJournal(format!(
                "database contains {stored_count} events but incoming journal contains {incoming_count}"
            )));
        }

        let stored_count = usize::try_from(stored_count).map_err(|_| {
            PersistenceError::InvalidJournal("database contains a negative event count".into())
        })?;
        for entry in journal.entries.iter().take(stored_count) {
            let sequence = i64::try_from(entry.sequence).map_err(|_| {
                PersistenceError::InvalidJournal("journal sequence exceeds SQLite range".into())
            })?;
            let stored: String = transaction.query_row(
                "SELECT payload_json FROM domain_events WHERE sequence = ?1",
                params![sequence],
                |row| row.get(0),
            )?;
            let stored_event = serde_json::from_str::<DomainEvent>(&stored)?;
            if stored_event != entry.event {
                return Err(PersistenceError::InvalidJournal(format!(
                    "database event {} does not match the runtime journal",
                    entry.sequence
                )));
            }
        }

        for entry in journal.entries.iter().skip(stored_count) {
            let payload = serde_json::to_string(&entry.event)?;
            let sequence = i64::try_from(entry.sequence).map_err(|_| {
                PersistenceError::InvalidJournal("journal sequence exceeds SQLite range".into())
            })?;
            transaction.execute(
                "INSERT INTO domain_events(sequence, event_type, payload_json) VALUES (?1, ?2, ?3)",
                params![sequence, event_type(&entry.event), payload],
            )?;
            normalize_event(&transaction, entry.sequence, &entry.event)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn load(&self) -> Result<RuntimeJournal, PersistenceError> {
        if !self.path.exists() {
            return Err(PersistenceError::Io(std::io::Error::from(
                std::io::ErrorKind::NotFound,
            )));
        }
        let connection = self.open()?;
        let format_version = metadata(&connection, "journal_format_version")?
            .ok_or_else(|| PersistenceError::InvalidJournal("database is uninitialized".into()))?
            .parse::<u64>()
            .map_err(|_| {
                PersistenceError::InvalidJournal(
                    "database contains an invalid journal format version".into(),
                )
            })?;
        let config_revision = phenix_core::ConfigRevisionId::parse(
            metadata(&connection, "initial_config_revision")?.ok_or_else(|| {
                PersistenceError::InvalidJournal("missing initial config revision".into())
            })?,
        )
        .map_err(|error| {
            PersistenceError::InvalidJournal(format!("invalid initial config revision: {error}"))
        })?;
        let config_fingerprint: crate::ConfigRevisionFingerprint = serde_json::from_str(
            &metadata(&connection, "initial_config_fingerprint")?.ok_or_else(|| {
                PersistenceError::InvalidJournal("missing initial config fingerprint".into())
            })?,
        )?;
        let mut statement = connection
            .prepare("SELECT sequence, payload_json FROM domain_events ORDER BY sequence")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut entries = Vec::new();
        for row in rows {
            let (sequence, payload) = row?;
            let sequence = u64::try_from(sequence).map_err(|_| {
                PersistenceError::InvalidJournal(
                    "database contains an invalid journal sequence".into(),
                )
            })?;
            entries.push(crate::JournalEntry {
                sequence,
                event: serde_json::from_str(&payload)?,
            });
        }
        let journal = RuntimeJournal {
            format_version,
            config_revision,
            config_fingerprint,
            entries,
        };
        journal
            .validate_structure()
            .map_err(|error| PersistenceError::InvalidJournal(error.to_string()))?;
        Ok(journal)
    }
}

fn migrate(connection: &Connection) -> Result<(), PersistenceError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version INTEGER PRIMARY KEY,
             applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );",
    )?;
    let version = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    if version > DATABASE_SCHEMA_VERSION {
        return Err(PersistenceError::InvalidJournal(format!(
            "database schema version {version} is newer than supported version {DATABASE_SCHEMA_VERSION}"
        )));
    }
    if version == 0 {
        connection.execute_batch(include_str!("../migrations/0001_runtime.sql"))?;
        connection.execute(
            "INSERT INTO schema_migrations(version) VALUES (?1)",
            params![1],
        )?;
    }
    if version < 2 {
        connection.execute_batch(include_str!("../migrations/0002_orchestration_data.sql"))?;
        connection.execute("INSERT INTO schema_migrations(version) VALUES (2)", [])?;
    }
    Ok(())
}

fn metadata(connection: &Connection, key: &str) -> Result<Option<String>, PersistenceError> {
    Ok(connection
        .query_row(
            "SELECT value FROM runtime_metadata WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?)
}

fn initialize_or_validate_database(
    transaction: &Transaction<'_>,
    journal: &RuntimeJournal,
) -> Result<(), PersistenceError> {
    let existing = transaction
        .query_row(
            "SELECT value FROM runtime_metadata WHERE key = 'initial_config_revision'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let revision = journal.config_revision.to_string();
    let fingerprint = serde_json::to_string(&journal.config_fingerprint)?;
    match existing {
        None => {
            transaction.execute(
                "INSERT INTO runtime_metadata(key, value) VALUES
                 ('journal_format_version', ?1),
                 ('initial_config_revision', ?2),
                 ('initial_config_fingerprint', ?3)",
                params![journal.format_version.to_string(), revision, fingerprint],
            )?;
            transaction.execute(
                "INSERT INTO configuration_revisions(revision_id, fingerprint, activated_sequence)
                 VALUES (?1, ?2, 0)",
                params![
                    journal.config_revision.to_string(),
                    journal.config_fingerprint.to_string()
                ],
            )?;
        }
        Some(existing_revision) => {
            let existing_format = transaction.query_row(
                "SELECT value FROM runtime_metadata WHERE key = 'journal_format_version'",
                [],
                |row| row.get::<_, String>(0),
            )?;
            let existing_fingerprint = transaction.query_row(
                "SELECT value FROM runtime_metadata WHERE key = 'initial_config_fingerprint'",
                [],
                |row| row.get::<_, String>(0),
            )?;
            if existing_revision != revision
                || existing_format != journal.format_version.to_string()
                || existing_fingerprint != fingerprint
            {
                return Err(PersistenceError::InvalidJournal(
                    "runtime journal does not match the database identity".into(),
                ));
            }
        }
    }
    Ok(())
}

fn event_type(event: &DomainEvent) -> &'static str {
    match event {
        DomainEvent::ConfigurationRevisionActivated { .. } => "configuration_revision_activated",
        DomainEvent::SessionCreated { .. } => "session_created",
        DomainEvent::SessionConfigRebased { .. } => "session_config_rebased",
        DomainEvent::SessionRenamed { .. } => "session_renamed",
        DomainEvent::SessionTargetChanged { .. } => "session_target_changed",
        DomainEvent::SessionClosed { .. } => "session_closed",
        DomainEvent::ExecutionCreated { .. } => "execution_created",
        DomainEvent::RootSubmissionAccepted { .. } => "root_submission_accepted",
        DomainEvent::ExecutionStateChanged { .. } => "execution_state_changed",
        DomainEvent::AttemptGroupCreated { .. } => "attempt_group_created",
        DomainEvent::AttemptFailureRecorded { .. } => "attempt_failure_recorded",
        DomainEvent::AttemptRetryStarted { .. } => "attempt_retry_started",
        DomainEvent::OrchestrationFailureInterfaceStarted { .. } => {
            "orchestration_failure_interface_started"
        }
        DomainEvent::OrchestrationDecisionMade { .. } => "orchestration_decision_made",
        DomainEvent::OrchestrationNodeStarted { .. } => "orchestration_node_started",
        DomainEvent::OrchestrationNodeInputBound { .. } => "orchestration_node_input_bound",
        DomainEvent::OrchestrationSynthesisStarted { .. } => "orchestration_synthesis_started",
        DomainEvent::ExecutionOutputRecorded { .. } => "execution_output_recorded",
        DomainEvent::InvocationResolved { .. } => "invocation_resolved",
        DomainEvent::WorkspaceCheckpointCaptured { .. } => "workspace_checkpoint_captured",
        DomainEvent::WorkspaceFileObserved { .. } => "workspace_file_observed",
        DomainEvent::FrontendEvent { .. } => "frontend_event",
    }
}

fn normalize_event(
    transaction: &Transaction<'_>,
    sequence: u64,
    event: &DomainEvent,
) -> Result<(), PersistenceError> {
    let sequence = i64::try_from(sequence).map_err(|_| {
        PersistenceError::InvalidJournal("journal sequence exceeds SQLite range".into())
    })?;
    match event {
        DomainEvent::ConfigurationRevisionActivated {
            revision,
            fingerprint,
        } => {
            transaction.execute(
                "INSERT INTO configuration_revisions(revision_id, fingerprint, activated_sequence)
                 VALUES (?1, ?2, ?3)",
                params![revision.to_string(), fingerprint.to_string(), sequence],
            )?;
        }
        DomainEvent::SessionCreated { session } => {
            transaction.execute(
                "INSERT INTO sessions(
                     session_id, parent_session_id, workspace_id, config_revision_id, name,
                     default_target_json, state, created_sequence
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    session.id.to_string(),
                    session.parent_session.as_ref().map(ToString::to_string),
                    session.workspace_id.to_string(),
                    session.config_revision.to_string(),
                    session.name.as_deref(),
                    serde_json::to_string(&session.default_target)?,
                    serde_json::to_string(&session.state)?,
                    sequence,
                ],
            )?;
        }
        DomainEvent::SessionConfigRebased {
            session_id,
            config_revision,
        } => {
            transaction.execute(
                "UPDATE sessions SET config_revision_id = ?1 WHERE session_id = ?2",
                params![config_revision.to_string(), session_id.to_string()],
            )?;
        }
        DomainEvent::SessionRenamed { session_id, name } => {
            transaction.execute(
                "UPDATE sessions SET name = ?1 WHERE session_id = ?2",
                params![name, session_id.to_string()],
            )?;
        }
        DomainEvent::SessionTargetChanged { session_id, target } => {
            transaction.execute(
                "UPDATE sessions SET default_target_json = ?1 WHERE session_id = ?2",
                params![serde_json::to_string(target)?, session_id.to_string()],
            )?;
        }
        DomainEvent::SessionClosed { session_id } => {
            transaction.execute(
                "UPDATE sessions SET state = ?1 WHERE session_id = ?2",
                params![
                    serde_json::to_string(&phenix_core::SessionState::Closed)?,
                    session_id.to_string()
                ],
            )?;
        }
        DomainEvent::ExecutionCreated { execution, payload } => {
            let config_revision = if let Some(parent) = execution.parent_execution.as_ref() {
                transaction.query_row(
                    "SELECT config_revision_id FROM executions WHERE execution_id = ?1",
                    params![parent.to_string()],
                    |row| row.get::<_, String>(0),
                )?
            } else {
                transaction.query_row(
                    "SELECT config_revision_id FROM sessions WHERE session_id = ?1",
                    params![execution.session_id.to_string()],
                    |row| row.get::<_, String>(0),
                )?
            };
            transaction.execute(
                "INSERT INTO executions(
                     execution_id, session_id, parent_execution_id, kind, callable_id,
                     target_json, state, config_revision_id, payload_json,
                     effective_authority_json, created_sequence
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    execution.id.to_string(),
                    execution.session_id.to_string(),
                    execution.parent_execution.as_ref().map(ToString::to_string),
                    serde_json::to_string(&execution.kind)?,
                    execution.callable.as_ref().map(ToString::to_string),
                    serde_json::to_string(&execution.target)?,
                    serde_json::to_string(&execution.state)?,
                    config_revision,
                    serde_json::to_string(payload)?,
                    serde_json::to_string(payload.authority())?,
                    sequence,
                ],
            )?;
        }
        DomainEvent::RootSubmissionAccepted {
            session_id,
            execution_id,
            ingress_order,
        } => {
            transaction.execute(
                "INSERT INTO accepted_root_submissions(
                     session_id, ingress_order, execution_id, accepted_sequence
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    session_id.to_string(),
                    i64::try_from(*ingress_order).map_err(|_| {
                        PersistenceError::InvalidJournal(
                            "root ingress order exceeds SQLite range".into(),
                        )
                    })?,
                    execution_id.to_string(),
                    sequence,
                ],
            )?;
        }
        DomainEvent::ExecutionStateChanged {
            execution_id,
            state,
        } => {
            transaction.execute(
                "UPDATE executions SET state = ?1 WHERE execution_id = ?2",
                params![serde_json::to_string(state)?, execution_id.to_string()],
            )?;
        }
        DomainEvent::AttemptGroupCreated { group } => {
            transaction.execute(
                "INSERT INTO attempt_groups(
                     attempt_group_id, parent_execution_id, callable_id, invariant_goal,
                     created_sequence
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    group.id.to_string(),
                    group.parent_execution.to_string(),
                    group.callable.to_string(),
                    group.goal.as_str(),
                    sequence,
                ],
            )?;
            for (index, execution_id) in group.attempts.iter().enumerate() {
                let attempt = i64::try_from(index + 1).map_err(|_| {
                    PersistenceError::InvalidJournal("attempt number exceeds SQLite range".into())
                })?;
                transaction.execute(
                    "INSERT INTO attempt_executions(
                         attempt_group_id, attempt_number, execution_id, started_sequence
                     ) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        group.id.to_string(),
                        attempt,
                        execution_id.to_string(),
                        sequence
                    ],
                )?;
            }
            for failure in &group.failures {
                insert_attempt_failure(transaction, sequence, &group.id.to_string(), failure)?;
            }
        }
        DomainEvent::AttemptFailureRecorded { group_id, failure } => {
            insert_attempt_failure(transaction, sequence, &group_id.to_string(), failure)?;
        }
        DomainEvent::AttemptRetryStarted {
            group_id,
            execution_id,
        } => {
            let attempt = transaction.query_row(
                "SELECT COALESCE(MAX(attempt_number), 0) + 1
                 FROM attempt_executions WHERE attempt_group_id = ?1",
                params![group_id.to_string()],
                |row| row.get::<_, i64>(0),
            )?;
            transaction.execute(
                "INSERT INTO attempt_executions(
                     attempt_group_id, attempt_number, execution_id, started_sequence
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    group_id.to_string(),
                    attempt,
                    execution_id.to_string(),
                    sequence
                ],
            )?;
        }
        DomainEvent::OrchestrationFailureInterfaceStarted {
            parent_execution,
            failed_child,
            interface_execution,
        } => {
            transaction.execute(
                "INSERT INTO orchestration_failure_interfaces(
                     failed_child_execution_id, parent_execution_id, interface_execution_id,
                     started_sequence
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    failed_child.to_string(),
                    parent_execution.to_string(),
                    interface_execution.to_string(),
                    sequence,
                ],
            )?;
        }
        DomainEvent::OrchestrationDecisionMade { decision } => {
            transaction.execute(
                "INSERT INTO parent_failure_decisions(
                     failed_child_execution_id, parent_execution_id, decider_execution_id,
                     decision_json, decided_sequence
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    decision.failed_child.to_string(),
                    decision.parent_execution.to_string(),
                    decision.decider_execution.as_ref().map(ToString::to_string),
                    serde_json::to_string(&decision.decision)?,
                    sequence,
                ],
            )?;
        }
        DomainEvent::OrchestrationNodeStarted {
            execution_id,
            node_id,
            child_execution_id,
        } => {
            transaction.execute(
                "INSERT INTO orchestration_node_bindings(
                     orchestration_execution_id, node_id, child_execution_id, bound_sequence
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    execution_id.to_string(),
                    node_id.to_string(),
                    child_execution_id.to_string(),
                    sequence,
                ],
            )?;
        }
        DomainEvent::OrchestrationNodeInputBound {
            execution_id,
            node_id,
            input,
        } => {
            transaction.execute(
                "INSERT INTO orchestration_node_inputs(
                     orchestration_execution_id, node_id, input_json, bound_sequence
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    execution_id.to_string(),
                    node_id.to_string(),
                    serde_json::to_string(input)?,
                    sequence,
                ],
            )?;
        }
        DomainEvent::OrchestrationSynthesisStarted {
            execution_id,
            interface_execution_id,
        } => {
            transaction.execute(
                "INSERT INTO orchestration_synthesis(
                     orchestration_execution_id, interface_execution_id, started_sequence
                 ) VALUES (?1, ?2, ?3)",
                params![
                    execution_id.to_string(),
                    interface_execution_id.to_string(),
                    sequence,
                ],
            )?;
        }
        DomainEvent::ExecutionOutputRecorded {
            execution_id,
            output,
        } => {
            transaction.execute(
                "INSERT INTO execution_outputs(execution_id, output_json, recorded_sequence)
                 VALUES (?1, ?2, ?3)",
                params![
                    execution_id.to_string(),
                    serde_json::to_string(output)?,
                    sequence,
                ],
            )?;
        }
        DomainEvent::InvocationResolved {
            execution_id,
            route,
        } => {
            transaction.execute(
                "INSERT INTO resolved_routing(
                     execution_id, requested_target_json, model_json, config_revision_id,
                     resolved_sequence
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    execution_id.to_string(),
                    serde_json::to_string(&route.requested_target)?,
                    serde_json::to_string(&route.model)?,
                    route.config_revision.to_string(),
                    sequence,
                ],
            )?;
        }
        DomainEvent::WorkspaceCheckpointCaptured {
            execution_id,
            workspace_id,
            files,
        } => {
            transaction.execute(
                "INSERT INTO workspace_checkpoints(
                     checkpoint_sequence, execution_id, workspace_id, files_json
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    sequence,
                    execution_id.to_string(),
                    workspace_id.to_string(),
                    serde_json::to_string(files)?,
                ],
            )?;
        }
        DomainEvent::WorkspaceFileObserved {
            execution_id,
            observation,
        } => {
            transaction.execute(
                "INSERT OR IGNORE INTO workspace_observations(
                     execution_id, path, version_json, observed_sequence
                 ) VALUES (?1, ?2, ?3, ?4)",
                params![
                    execution_id.to_string(),
                    observation.path.to_string_lossy(),
                    serde_json::to_string(&observation.version)?,
                    sequence,
                ],
            )?;
        }
        DomainEvent::FrontendEvent { event } => {
            let event_sequence = i64::try_from(event.sequence).map_err(|_| {
                PersistenceError::InvalidJournal(
                    "frontend event sequence exceeds SQLite range".into(),
                )
            })?;
            transaction.execute(
                "INSERT INTO canonical_events(
                     event_sequence, journal_sequence, session_id, execution_id, kind, event_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    event_sequence,
                    sequence,
                    event.session_id.to_string(),
                    event.execution_id.to_string(),
                    execution_event_type(&event.kind),
                    serde_json::to_string(event)?,
                ],
            )?;
            match &event.kind {
                ExecutionEventKind::ExecutionTerminated { cause } => {
                    transaction.execute(
                        "INSERT INTO termination_causes(
                             execution_id, cause_json, event_sequence
                         ) VALUES (?1, ?2, ?3)",
                        params![
                            event.execution_id.to_string(),
                            serde_json::to_string(cause)?,
                            event_sequence,
                        ],
                    )?;
                }
                ExecutionEventKind::ToolCallStarted { tool_call_id, .. }
                | ExecutionEventKind::ToolCallArguments { tool_call_id, .. }
                | ExecutionEventKind::ToolCallFinished { tool_call_id, .. } => {
                    transaction.execute(
                        "INSERT INTO tool_activity(
                             tool_call_id, event_sequence, execution_id, phase, activity_json
                         ) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            tool_call_id.to_string(),
                            event_sequence,
                            event.execution_id.to_string(),
                            execution_event_type(&event.kind),
                            serde_json::to_string(&event.kind)?,
                        ],
                    )?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn insert_attempt_failure(
    transaction: &Transaction<'_>,
    sequence: i64,
    group_id: &str,
    failure: &phenix_core::FailureAttemptSummary,
) -> Result<(), PersistenceError> {
    transaction.execute(
        "INSERT INTO attempt_failures(
             attempt_group_id, attempt_number, execution_id, approach, failure_at, reason,
             completed_work_json, recorded_sequence
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            group_id,
            i64::from(failure.attempt),
            failure.execution_id.to_string(),
            failure.approach.as_str(),
            failure.failure_at.as_str(),
            failure.reason.as_str(),
            serde_json::to_string(&failure.completed_work)?,
            sequence,
        ],
    )?;
    Ok(())
}

fn execution_event_type(kind: &ExecutionEventKind) -> &'static str {
    match kind {
        ExecutionEventKind::UserInput { .. } => "user_input",
        ExecutionEventKind::ExecutionStateChanged { .. } => "execution_state_changed",
        ExecutionEventKind::ExecutionTerminated { .. } => "execution_terminated",
        ExecutionEventKind::AssistantContentDelta { .. } => "assistant_content_delta",
        ExecutionEventKind::ReasoningDelta { .. } => "reasoning_delta",
        ExecutionEventKind::ToolCallStarted { .. } => "tool_call_started",
        ExecutionEventKind::ToolCallArguments { .. } => "tool_call_arguments",
        ExecutionEventKind::ToolCallFinished { .. } => "tool_call_finished",
        ExecutionEventKind::ChildExecutionStarted { .. } => "child_execution_started",
        ExecutionEventKind::ChildExecutionFinished { .. } => "child_execution_finished",
        ExecutionEventKind::OrchestrationDecisionMade { .. } => "orchestration_decision_made",
        ExecutionEventKind::Error { .. } => "error",
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
        let config_fingerprint = journal.config_fingerprint.clone();
        let mut runtime = Self::new();
        runtime.config_revision = config_revision.clone();
        runtime.config_revisions.clear();
        runtime.config_revisions.insert(
            config_revision.clone(),
            ConfigRevisionSlot {
                fingerprint: config_fingerprint.clone(),
                configuration: None,
            },
        );
        runtime.next_config_revision = 1;
        runtime.journal = RuntimeJournal::new(config_revision, config_fingerprint);

        for entry in &journal.entries {
            let mut projection = DurableProjection {
                config_revisions: &mut runtime.config_revisions,
                current_config_revision: &mut runtime.config_revision,
                sessions: &mut runtime.sessions,
                executions: &mut runtime.executions,
                root_ingress: &mut runtime.root_ingress,
                next_root_ingress: &mut runtime.next_root_ingress,
                attempt_groups: &mut runtime.attempt_groups,
                orchestration_decisions: &mut runtime.orchestration_decisions,
                orchestration_interfaces: &mut runtime.orchestration_interfaces,
                orchestration_nodes: &mut runtime.orchestration_nodes,
                orchestration_node_inputs: &mut runtime.orchestration_node_inputs,
                orchestration_synthesis: &mut runtime.orchestration_synthesis,
                execution_outputs: &mut runtime.execution_outputs,
                resolved_routes: &mut runtime.resolved_routes,
                read_sets: &mut runtime.read_sets,
                events: &mut runtime.events,
                next_config_revision: &mut runtime.next_config_revision,
                next_session: &mut runtime.next_session,
                next_execution: &mut runtime.next_execution,
                next_attempt_group: &mut runtime.next_attempt_group,
                next_event: &mut runtime.next_event,
                next_tool_call: &mut runtime.next_tool_call,
            };
            apply_domain_event(&mut projection, &entry.event)
                .map_err(|error| PersistenceError::InvalidJournal(error.to_string()))?;
        }

        if runtime.executions.values().any(|execution| {
            execution.summary.parent_execution.is_none()
                && !runtime.root_ingress.contains_key(&execution.summary.id)
        }) {
            return Err(PersistenceError::InvalidJournal(
                "root execution is missing durable ingress order".into(),
            ));
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
    use crate::{ConductorError, DomainEvent};
    use phenix_core::{
        BackendId, CallableDescriptor, CallableId, CallableKind, CallablePolicy, CapabilitySet,
        ExecutionKind, ExecutionState, ExecutionTarget, InferenceOptions, ModelId, ModelTarget,
        OrchestrationDefinition, OrchestrationNode, OrchestrationNodeId, ProviderId,
        RoutingProfile, RoutingProfileId, SessionId, WorkspaceId,
    };
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::fs;
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
            input_bindings: Default::default(),
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
                output_bindings: Default::default(),
                interface_agent: None,
                descriptor: descriptor("orchestration.test", CallableKind::Orchestration),
                nodes: vec![
                    node("first", "agent.first", &[], Some("first")),
                    node("second", "agent.second", &["first"], None),
                ],
            })
            .unwrap();
    }

    fn temporary_store() -> (SqliteStore, PathBuf) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "phenix-conductor-runtime-{}-{unique}.sqlite3",
            std::process::id()
        ));
        (SqliteStore::new(&path), path)
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
                json!({"objective": "orchestration objective"}),
            )
            .unwrap();
        let revision = runtime.current_config_revision().clone();
        let configuration = runtime.current_compiled_configuration().unwrap();
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
        assert!(matches!(
            restored.callable_descriptors(),
            Err(ConductorError::UnboundConfigRevision(id)) if id == revision
        ));
        restored
            .bind_configuration_revision(&revision, configuration)
            .unwrap();
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
    fn sqlite_wal_store_appends_and_normalizes_durable_state() {
        let mut runtime = ConductorRuntime::new();
        let session = runtime.create_session(None, None, fixed()).unwrap();
        let first = runtime.submit(&session.id, "first").unwrap();
        let (store, path) = temporary_store();
        store.save(runtime.journal()).unwrap();

        let second = runtime.submit(&session.id, "second").unwrap();
        store.save(runtime.journal()).unwrap();
        store.save(runtime.journal()).unwrap();

        let connection = store.open().unwrap();
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        let migration: i64 = connection
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        let sessions: i64 = connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        let executions: i64 = connection
            .query_row("SELECT COUNT(*) FROM executions", [], |row| row.get(0))
            .unwrap();
        let accepted = connection
            .prepare(
                "SELECT ingress_order, execution_id FROM accepted_root_submissions
                 WHERE session_id = ?1 ORDER BY ingress_order",
            )
            .unwrap()
            .query_map(params![session.id.to_string()], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(journal_mode, "wal");
        assert_eq!(migration, DATABASE_SCHEMA_VERSION);
        assert_eq!(sessions, 1);
        assert_eq!(executions, 2);
        assert_eq!(
            accepted,
            vec![(1, first.id.to_string()), (2, second.id.to_string()),]
        );
        assert_eq!(store.load().unwrap(), runtime.journal().clone());
        drop(connection);
        fs::remove_file(path).unwrap();
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

        let restored = ConductorRuntime::restore(runtime.journal().clone()).unwrap();
        let resolved = restored
            .resolved_routes
            .get(&execution.id)
            .expect("resolved route survives journal replay");
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
