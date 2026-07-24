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

Synthesize the supplied deterministic checks and independent QA reports. Deduplicate overlapping observations, rank actionable findings by severity, preserve evidence, and do not perform repository work.
