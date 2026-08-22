CREATE TABLE orchestration_node_bindings (
    orchestration_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    node_id TEXT NOT NULL,
    child_execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    bound_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence),
    PRIMARY KEY(orchestration_execution_id, node_id)
) STRICT;

CREATE TABLE orchestration_node_inputs (
    orchestration_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    node_id TEXT NOT NULL,
    input_value_id INTEGER NOT NULL REFERENCES structured_values(value_id),
    bound_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence),
    PRIMARY KEY(orchestration_execution_id, node_id)
) STRICT;

CREATE TABLE orchestration_synthesis (
    orchestration_execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    interface_execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    started_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence)
) STRICT;

CREATE TABLE execution_outputs (
    execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    output_value_id INTEGER NOT NULL REFERENCES structured_values(value_id),
    recorded_sequence INTEGER NOT NULL UNIQUE REFERENCES domain_events(sequence)
) STRICT;
