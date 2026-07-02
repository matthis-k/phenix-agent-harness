# Phenix agent harness

This flake packages the Phenix OpenCode and Pi agent harness resources.

## Agent communication MCP

`phenix-agent-comm-mcp` is a generic local MCP server for durable agent
communication. It stores sessions, agents, messages, task graphs, events,
artifacts, and decisions in SQLite under the user's XDG data directory.

The Rust core is intentionally policy-free: it records communication and
references/results only. It does not run shell commands, edit source files, or
duplicate Tend/Stitch behavior. Tend remains responsible for verification; Stitch
remains responsible for DAG-aware repository coordination.

Useful debug commands:

```sh
phenix-agent-comm-mcp init
phenix-agent-comm-mcp tool comm_session_init --args '{"name":"example"}'
phenix-agent-comm-mcp stdio-mcp
```

OpenCode is configured with a local `agent_comm` MCP server and canonical
`agent_comm_*` permissions. The MCP tool names themselves currently use the
`comm_` prefix (for example `comm_session_init`, `comm_agent_register`,
`comm_message_send`, `comm_task_create`, `comm_event_recent`,
`comm_artifact_record`, and `comm_decision_record`), but OpenCode permissions
must always use the server namespace. Agents should use MCP records rather than
writing handoff state into the repository.
