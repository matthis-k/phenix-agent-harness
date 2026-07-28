# Stock Pi session

```phenix-agent
id: session.stock
description: Run an ordinary Pi session with no Phenix role prompt or workflow tools; the invoking workflow supplies the concrete typed output schema.
input: request.stock-session
output: outcome.stock-session-handoff
model: session
thinking: route
persistence: file
session-mode: stock
```

## Models

| Difficulty | Model | Capability | Thinking |
|---|---|---|---|
| `D0` | `session` | `fast` | `low` |
| `D1` | `session` | `general` | `low` |
| `D2` | `session` | `reasoning` | `medium` |
| `D3` | `session` | `reasoning` | `high` |

## Tools

```phenix-tools
allow:
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
allow:
max-depth: 4
may-detach: false
may-send: false
may-cancel-children: false
```

## Limits

```phenix-limits
timeout-ms: 1200000
max-turns: 40
max-repair-attempts: 2
```

## Prompt

PHENIX_STOCK_SESSION
