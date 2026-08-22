CREATE TABLE diagnostic_write_patches (
    patch_id INTEGER PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES executions(execution_id),
    path TEXT NOT NULL,
    patch TEXT NOT NULL,
    captured_sequence INTEGER NOT NULL UNIQUE
) STRICT;
