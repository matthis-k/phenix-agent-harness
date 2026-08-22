CREATE TABLE orchestration_node_inputs (
    orchestration_execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    node_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    bound_sequence INTEGER NOT NULL UNIQUE,
    PRIMARY KEY(orchestration_execution_id, node_id)
) STRICT;

CREATE TABLE orchestration_synthesis (
    orchestration_execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    interface_execution_id TEXT NOT NULL UNIQUE REFERENCES executions(execution_id),
    started_sequence INTEGER NOT NULL UNIQUE
) STRICT;

CREATE TABLE execution_outputs (
    execution_id TEXT PRIMARY KEY REFERENCES executions(execution_id),
    output_json TEXT NOT NULL,
    recorded_sequence INTEGER NOT NULL UNIQUE
) STRICT;
