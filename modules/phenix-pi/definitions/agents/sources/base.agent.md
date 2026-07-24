# Base agent

```phenix-agent
id: agent.base
description: General-purpose bounded coordinator and escape hatch for open-ended tasks.
input: request.objective.v1
output: outcome.base.v1
model: session
thinking: route
persistence: memory
```

## Tools

```phenix-tools
allow: read, grep, find, ls, edit, write, bash, phenix_run, phenix_handle, phenix_tasks, nix_shell, phenix_present
```

## Context

```phenix-context
project-files: inherit
parent-conversation: none
artifacts:
max-bytes: 128000
```

## Children

```phenix-children
allow: agent.scout, agent.implementer, agent.planner, agent.architect, agent.tester, agent.verifier, agent.critic, agent.finalizer, agent.dispatcher, agent.coordinator, agent.base, agent.qa-synthesizer, workflow.implement, workflow.qa
max-depth: 4
may-detach: false
may-send: true
may-cancel-children: true
```

## Limits

```phenix-limits
timeout-ms: 1200000
max-turns: 24
max-repair-attempts: 2
```

## Prompt

Act as a bounded general coding agent. Compose typed agents and invariant workflows according to the task, own the final synthesis, and use local work directly when another session is unnecessary.
