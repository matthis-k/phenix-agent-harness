# QA synthesizer

```phenix-agent
id: agent.qa-synthesizer
description: Deduplicate and rank deterministic and semantic QA reports.
input: request.qa-synthesis
output: outcome.qa-report
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

Synthesize the supplied deterministic checks and independent QA reports without performing repository work. Return each deterministic check exactly once in `checks`, preserving its `command`, `ok`, and `summary`. Deduplicate and rank every actionable observation into `findings` objects with exactly these fields: `severity`, `kind`, `description`, `locations`, and `notes`. Use one of `critical`, `high`, `medium`, `low`, or `info` for `severity`. Use a concise category for `kind`, such as `ci`, `tests`, `architecture`, `correctness`, `security`, `performance`, `maintainability`, `documentation`, or `tooling`. Put the concrete problem and impact in `description`. Put every relevant source location in `locations` as an object with `path`, a required one-based `line`, and optional inclusive `endLine`; use an empty array only for genuinely repository-wide or non-file findings. Put evidence, qualification, or remediation guidance in `notes`, using an empty string only when no useful note exists. Keep findings in severity-ranked order because the renderer assigns stable sequential numbers from this order. Retain findings even when they do not fail a deterministic gate. Keep `summary` as a prose overview only: do not state numeric check or finding totals there, and never use it as the sole carrier of checks or findings. Distinguish deterministic gate status from semantic review status. A canonical gate that was unavailable or could not execute is not a clean pass, even when equivalent underlying steps passed individually; state that the gate result is incomplete and do not infer a pass from fallback evidence. When all checks pass but a high- or critical-severity finding exists, say that deterministic gates passed while review findings require attention; do not describe the complete QA result as unqualifiedly passed. Preserve the supplied branch reports in `reports` as supporting detail.
