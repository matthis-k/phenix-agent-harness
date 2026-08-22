CREATE TABLE runtime_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE domain_events (
    sequence INTEGER PRIMARY KEY,
    event_type TEXT NOT NULL
) STRICT;

CREATE TABLE configuration_revisions (
    revision_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    activated_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE targets (
    target_id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('fixed', 'routed')),
    backend_id TEXT,
    provider_id TEXT,
    model_id TEXT,
    inference_effort TEXT,
    routing_profile_id TEXT,
    CHECK (
        (kind = 'fixed' AND backend_id IS NOT NULL AND provider_id IS NOT NULL
            AND model_id IS NOT NULL AND routing_profile_id IS NULL)
        OR
        (kind = 'routed' AND backend_id IS NULL AND provider_id IS NULL
            AND model_id IS NULL AND inference_effort IS NULL
            AND routing_profile_id IS NOT NULL)
    )
) STRICT;

CREATE TABLE structured_values (
    value_id INTEGER PRIMARY KEY
) STRICT;

CREATE TABLE structured_value_nodes (
    node_id INTEGER PRIMARY KEY,
    value_id INTEGER NOT NULL REFERENCES structured_values(value_id) ON DELETE CASCADE,
    parent_node_id INTEGER REFERENCES structured_value_nodes(node_id) ON DELETE CASCADE,
    object_key TEXT,
    array_index INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('null', 'boolean', 'number', 'string', 'array', 'object')),
    scalar TEXT,
    CHECK (
        (kind IN ('boolean', 'number', 'string') AND scalar IS NOT NULL)
        OR (kind IN ('null', 'array', 'object') AND scalar IS NULL)
    ),
    CHECK (
        (parent_node_id IS NULL AND object_key IS NULL AND array_index IS NULL)
        OR (parent_node_id IS NOT NULL AND (object_key IS NULL) != (array_index IS NULL))
    )
) STRICT;

CREATE UNIQUE INDEX structured_value_object_keys
ON structured_value_nodes(parent_node_id, object_key)
WHERE object_key IS NOT NULL;

CREATE UNIQUE INDEX structured_value_array_indexes
ON structured_value_nodes(parent_node_id, array_index)
WHERE array_index IS NOT NULL;

CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    parent_session_id TEXT REFERENCES sessions(session_id),
    workspace_id TEXT NOT NULL,
    config_revision_id TEXT NOT NULL REFERENCES configuration_revisions(revision_id),
    name TEXT,
    default_target_id INTEGER NOT NULL REFERENCES targets(target_id),
    state TEXT NOT NULL,
    created_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence)
) STRICT;

CREATE TABLE session_config_rebases (
    sequence INTEGER PRIMARY KEY REFERENCES domain_events(sequence),
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    config_revision_id TEXT NOT NULL REFERENCES configuration_revisions(revision_id)
) STRICT;

CREATE TABLE session_renames (
    sequence INTEGER PRIMARY KEY REFERENCES domain_events(sequence),
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    name TEXT NOT NULL
) STRICT;

CREATE TABLE session_target_changes (
    sequence INTEGER PRIMARY KEY REFERENCES domain_events(sequence),
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    target_id INTEGER NOT NULL REFERENCES targets(target_id)
) STRICT;

CREATE TABLE session_closures (
    sequence INTEGER PRIMARY KEY REFERENCES domain_events(sequence),
    session_id TEXT NOT NULL REFERENCES sessions(session_id)
) STRICT;

CREATE TABLE executions (
    execution_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    parent_execution_id TEXT REFERENCES executions(execution_id),
    kind TEXT NOT NULL,
    callable_id TEXT,
    target_id INTEGER NOT NULL REFERENCES targets(target_id),
    state TEXT NOT NULL,
    config_revision_id TEXT NOT NULL REFERENCES configuration_revisions(revision_id),
    payload_kind TEXT NOT NULL CHECK (payload_kind IN ('invocation', 'orchestration')),
    input_text TEXT,
    input_value_id INTEGER REFERENCES structured_values(value_id),
    authority_filesystem TEXT NOT NULL,
    authority_network TEXT NOT NULL,
    authority_repository TEXT NOT NULL,
    created_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence),
    CHECK (
        (payload_kind = 'invocation' AND input_text IS NOT NULL AND input_value_id IS NULL)
        OR (payload_kind = 'orchestration' AND input_text IS NULL AND input_value_id IS NOT NULL)
    )
) STRICT;

CREATE INDEX executions_by_session ON executions(session_id, created_sequence);
CREATE INDEX executions_by_parent ON executions(parent_execution_id, created_sequence);

CREATE TABLE execution_authority_ipc (
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    endpoint TEXT NOT NULL,
    PRIMARY KEY(execution_id, endpoint)
) STRICT;

CREATE TABLE execution_authority_secrets (
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    secret_name TEXT NOT NULL,
    PRIMARY KEY(execution_id, secret_name)
) STRICT;

CREATE TABLE execution_authority_callables (
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    callable_id TEXT NOT NULL,
    PRIMARY KEY(execution_id, callable_id)
) STRICT;

CREATE TABLE accepted_root_submissions (
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    ingress_order INTEGER NOT NULL,
    execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    accepted_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence),
    PRIMARY KEY(session_id, ingress_order)
) STRICT;

CREATE TABLE execution_state_changes (
    sequence INTEGER PRIMARY KEY REFERENCES domain_events(sequence),
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    state TEXT NOT NULL
) STRICT;

CREATE TABLE canonical_events (
    event_sequence INTEGER PRIMARY KEY,
    journal_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence),
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    kind TEXT NOT NULL,
    text TEXT,
    state TEXT,
    termination_kind TEXT,
    termination_execution_id TEXT,
    tool_call_id TEXT,
    callable_id TEXT,
    output TEXT,
    success INTEGER,
    child_execution_id TEXT,
    decision_parent_execution_id TEXT,
    decision_failed_child_execution_id TEXT,
    decision_decider_execution_id TEXT,
    decision_kind TEXT,
    decision_recovery_execution_id TEXT,
    error_code TEXT,
    error_message TEXT
) STRICT;

CREATE INDEX canonical_events_by_session ON canonical_events(session_id, event_sequence);

CREATE VIEW tool_activity AS
SELECT tool_call_id, event_sequence, execution_id, kind AS phase,
       callable_id, text AS arguments, output, success
FROM canonical_events
WHERE tool_call_id IS NOT NULL;

CREATE TABLE resolved_routing (
    execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    requested_target_id INTEGER NOT NULL REFERENCES targets(target_id),
    model_target_id INTEGER NOT NULL REFERENCES targets(target_id),
    config_revision_id TEXT NOT NULL REFERENCES configuration_revisions(revision_id),
    resolved_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence)
) STRICT;

CREATE TABLE orchestration_failure_interfaces (
    failed_child_execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    parent_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    interface_execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    started_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence)
) STRICT;

CREATE TABLE parent_failure_decisions (
    failed_child_execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    parent_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    decider_execution_id TEXT REFERENCES executions(execution_id),
    decision_kind TEXT NOT NULL,
    recovery_execution_id TEXT REFERENCES executions(execution_id),
    decided_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence)
) STRICT;

CREATE TABLE attempt_groups (
    attempt_group_id TEXT PRIMARY KEY,
    parent_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    callable_id TEXT NOT NULL,
    invariant_goal TEXT NOT NULL,
    created_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence)
) STRICT;

CREATE TABLE attempt_executions (
    attempt_group_id TEXT NOT NULL REFERENCES attempt_groups(attempt_group_id),
    attempt_number INTEGER NOT NULL,
    execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    started_sequence INTEGER NOT NULL REFERENCES domain_events(sequence),
    PRIMARY KEY(attempt_group_id, attempt_number)
) STRICT;

CREATE TABLE attempt_failures (
    attempt_group_id TEXT NOT NULL REFERENCES attempt_groups(attempt_group_id),
    attempt_number INTEGER NOT NULL,
    execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    approach TEXT NOT NULL,
    failure_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    recorded_sequence INTEGER NOT NULL REFERENCES domain_events(sequence),
    PRIMARY KEY(attempt_group_id, attempt_number)
) STRICT;

CREATE TABLE attempt_completed_work (
    attempt_group_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    item_order INTEGER NOT NULL,
    item TEXT NOT NULL,
    PRIMARY KEY(attempt_group_id, attempt_number, item_order),
    FOREIGN KEY(attempt_group_id, attempt_number)
        REFERENCES attempt_failures(attempt_group_id, attempt_number)
) STRICT;

CREATE TABLE workspace_observation_events (
    observed_sequence INTEGER PRIMARY KEY REFERENCES domain_events(sequence),
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    path TEXT NOT NULL,
    version_state TEXT NOT NULL,
    content_hash TEXT,
    file_kind TEXT
) STRICT;

CREATE VIEW workspace_observations AS
SELECT event.execution_id, event.path, event.version_state, event.content_hash,
       event.file_kind, event.observed_sequence
FROM workspace_observation_events AS event
WHERE event.observed_sequence = (
    SELECT MIN(first_event.observed_sequence)
    FROM workspace_observation_events AS first_event
    WHERE first_event.execution_id = event.execution_id
      AND first_event.path = event.path
);

CREATE TABLE workspace_checkpoints (
    checkpoint_sequence INTEGER PRIMARY KEY REFERENCES domain_events(sequence),
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    workspace_id TEXT NOT NULL
) STRICT;

CREATE TABLE workspace_checkpoint_files (
    checkpoint_sequence INTEGER NOT NULL REFERENCES workspace_checkpoints(checkpoint_sequence),
    path TEXT NOT NULL,
    version_state TEXT NOT NULL,
    content_hash TEXT,
    file_kind TEXT,
    PRIMARY KEY(checkpoint_sequence, path)
) STRICT;

CREATE VIEW termination_causes AS
SELECT execution_id, termination_kind AS cause_kind,
       termination_execution_id AS related_execution_id, event_sequence
FROM canonical_events
WHERE kind = 'execution_terminated';
