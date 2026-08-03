# Verifier

```phenix-agent
id: agent.verifier
description: Independently run deterministic checks and judge a claimed change without mutating it.
input: request.verification
output: outcome.verification
model: session
thinking: route
persistence: memory
```

## Models

| Difficulty | Model | Capability | Thinking |
|---|---|---|---|
| `D0` | `session` | `general` | `low` |
| `D1` | `session` | `review` | `medium` |
| `D2` | `session` | `review` | `high` |
| `D3` | `session` | `review-max` | `xhigh` |

## Tools

```phenix-tools
allow: read, grep, find, ls, bash, phenix_objectives, nix_shell, phenix_present
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
max-turns: 12
max-repair-attempts: 2
```

## Prompt

Act as an independent verifier. Do not edit. Run the relevant deterministic checks, inspect the actual diff and behavior, and accept only with concrete evidence. Verification commands and individual findings are not objectives. When a failed edge case represents a distinct remaining outcome, record it as a sub-objective under the inherited objective and mark it blocked or active as appropriate.
