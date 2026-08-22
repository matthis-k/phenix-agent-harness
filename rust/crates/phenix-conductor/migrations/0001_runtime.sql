CREATE TABLE runtime_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE configuration_revisions (
    revision_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    activated_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    parent_session_id TEXT REFERENCES sessions(session_id),
    workspace_id TEXT NOT NULL,
    config_revision_id TEXT NOT NULL REFERENCES configuration_revisions(revision_id),
    name TEXT,
    default_target_json TEXT NOT NULL,
    state TEXT NOT NULL,
    created_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE executions (
    execution_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    parent_execution_id TEXT REFERENCES executions(execution_id),
    kind TEXT NOT NULL,
    callable_id TEXT,
    target_json TEXT NOT NULL,
    state TEXT NOT NULL,
    config_revision_id TEXT NOT NULL REFERENCES configuration_revisions(revision_id),
    payload_json TEXT NOT NULL,
    effective_authority_json TEXT NOT NULL,
    created_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE INDEX executions_by_session ON executions(session_id, created_sequence);
CREATE INDEX executions_by_parent ON executions(parent_execution_id, created_sequence);

CREATE TABLE accepted_root_submissions (
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    ingress_order INTEGER NOT NULL,
    execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    accepted_sequence INTEGER NOT NULL UNIQUE,
    PRIMARY KEY(session_id, ingress_order)
) STRICT;

CREATE TABLE canonical_events (
    event_sequence INTEGER PRIMARY KEY,
    journal_sequence INTEGER NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    kind TEXT NOT NULL,
    event_json TEXT NOT NULL
) STRICT;

CREATE INDEX canonical_events_by_session ON canonical_events(session_id, event_sequence);

CREATE TABLE resolved_routing (
    execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    requested_target_json TEXT NOT NULL,
    model_json TEXT NOT NULL,
    config_revision_id TEXT NOT NULL REFERENCES configuration_revisions(revision_id),
    resolved_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE orchestration_node_bindings (
    orchestration_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    node_id TEXT NOT NULL,
    child_execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    bound_sequence INTEGER NOT NULL UNIQUE,
    PRIMARY KEY(orchestration_execution_id, node_id)
) STRICT;

CREATE TABLE orchestration_failure_interfaces (
    failed_child_execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    parent_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    interface_execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    started_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE parent_failure_decisions (
    failed_child_execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    parent_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    decider_execution_id TEXT REFERENCES executions(execution_id),
    decision_json TEXT NOT NULL,
    decided_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE attempt_groups (
    attempt_group_id TEXT PRIMARY KEY,
    parent_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    callable_id TEXT NOT NULL,
    invariant_goal TEXT NOT NULL,
    created_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE attempt_executions (
    attempt_group_id TEXT NOT NULL REFERENCES attempt_groups(attempt_group_id),
    attempt_number INTEGER NOT NULL,
    execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    started_sequence INTEGER NOT NULL,
    PRIMARY KEY(attempt_group_id, attempt_number)
) STRICT;

CREATE TABLE attempt_failures (
    attempt_group_id TEXT NOT NULL REFERENCES attempt_groups(attempt_group_id),
    attempt_number INTEGER NOT NULL,
    execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    approach TEXT NOT NULL,
    failure_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    completed_work_json TEXT NOT NULL,
    recorded_sequence INTEGER NOT NULL,
    PRIMARY KEY(attempt_group_id, attempt_number)
) STRICT;

CREATE TABLE workspace_observations (
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    path TEXT NOT NULL,
    version_json TEXT NOT NULL,
    observed_sequence INTEGER NOT NULL,
    PRIMARY KEY(execution_id, path)
) STRICT;

CREATE TABLE workspace_checkpoints (
    checkpoint_sequence INTEGER PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    workspace_id TEXT NOT NULL,
    files_json TEXT NOT NULL
) STRICT;

CREATE TABLE termination_causes (
    execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    cause_json TEXT NOT NULL,
    event_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE tool_activity (
    tool_call_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    phase TEXT NOT NULL,
    activity_json TEXT NOT NULL,
    PRIMARY KEY(tool_call_id, event_sequence)
) STRICT;

CREATE TABLE domain_events (
    sequence INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL
) STRICT;
