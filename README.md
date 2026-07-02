# Phenix agent harness

This flake packages the Phenix OpenCode and Pi agent harness resources.

## Workflow state binary

`phenix-workflow-state` is a small generic Rust binary for storing workflow
sessions, tasks, and task events in SQLite. It is intentionally a minimal
vertical slice: it provides local CLI commands and newline-delimited JSON over
stdio, but it does not implement MCP, HTTP, socket, or daemon transports.

Useful commands:

```sh
phenix-workflow-state init
phenix-workflow-state create-session "example"
phenix-workflow-state create-task <session-id> "task title"
phenix-workflow-state list-tasks [session-id]
phenix-workflow-state record-event <task-id> note "message"
phenix-workflow-state summarize <session-id>
phenix-workflow-state stdio-json
```

The `stdio-json` mode reads one JSON request per line and writes one JSON
response per line. Example request:

```json
{"id":1,"method":"list_tasks","session_id":null}
```

The core model is intentionally generic and does not encode Tend, Stitch, or
OpenCode-specific semantics.
