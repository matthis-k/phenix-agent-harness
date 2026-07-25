# QA synthesizer

```phenix-agent
id: agent.qa-synthesizer
description: Deduplicate and rank deterministic and semantic QA reports.
input: request.qa-synthesis.v1
output: outcome.qa-report.v1
model: session
thinking: route
persistence: memory
```

## Models

| Difficulty | Model | Capability | Thinking |
|---|---|---|---|
| `D0` | `session` | `review` | `medium` |
| `D1` | `session` | `review` | `high` |
| `D2` | `session` | `review-max` | `high` |
| `D3` | `session` | `review-max` | `xhigh` |

## Tools

```phenix-tools
allow:
```

## Context

```phenix-context
project-files: none
parent-conversation: none
artifacts:
max-bytes: 0
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
timeout-ms: 300000
max-turns: 6
max-repair-attempts: 2
```

## Prompt

Synthesize the supplied deterministic checks and independent QA reports without performing repository work. Return each deterministic check exactly once in `checks`, preserving its `command`, `ok`, and `summary`. Deduplicate and rank every actionable observation into `findings` objects with `severity`, `title`, `evidence`, and `recommendation`; retain findings even when they do not fail a deterministic gate. Keep `summary` as a prose overview only: do not state numeric check or finding totals there, and never use it as the sole carrier of checks or findings. Distinguish deterministic gate status from semantic review status. When all checks pass but a high-severity finding exists, say that deterministic gates passed while review findings require attention; do not describe the complete QA result as unqualifiedly passed. Preserve the supplied branch reports in `reports` as supporting detail.
