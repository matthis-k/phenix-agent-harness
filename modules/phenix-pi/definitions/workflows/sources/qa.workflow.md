# QA workflow

```phenix-workflow
id: workflow.qa
description: Run deterministic project checks and independent repository, architecture, test, and security reviews, then synthesize.
input: request.objective.v1
output: outcome.qa-report.v1
entry: checks
timeout-ms: 2400000
max-node-runs: 20
max-parallelism: 4
```

## Flow

```mermaid
flowchart LR
    checks[Deterministic checks] --> fanout{Independent reviews}
    fanout --> repo[Repository]
    fanout --> tests[Tests]
    fanout --> architecture[Architecture]
    fanout --> security[Security]
    repo --> join((all success))
    tests --> join
    architecture --> join
    security --> join
    join --> synthesize[Synthesize]
    synthesize --> return([Return QA report])
```

## States

### checks

```phenix-state
kind: local
title: Run deterministic repository checks
operation: local.qa-checks
input: qa.checks.input
input-schema: request.qa-checks.v1
output-schema: outcome.check-results.v1
```

### fanout

```phenix-state
kind: local
title: Start independent QA branches
operation: local.noop
input: input.identity
input-schema: request.objective.v1
output-schema: request.objective.v1
```

### repo

```phenix-state
kind: invoke
title: Review repository structure and correctness
run: agent.scout
input: qa.repo.input
input-schema: request.scout.v1
output-schema: outcome.scout-report.v1
wait: await
```

### tests

```phenix-state
kind: invoke
title: Interpret deterministic checks and coverage gaps
run: agent.tester
input: qa.tests.input
input-schema: request.test.v1
output-schema: outcome.test-report.v1
wait: await
```

### architecture

```phenix-state
kind: invoke
title: Review architecture and module boundaries
run: agent.architect
input: qa.arch.input
input-schema: request.critic.v1
output-schema: outcome.critic-report.v1
wait: await
```

### security

```phenix-state
kind: invoke
title: Review security and trust boundaries
run: agent.critic
input: qa.security.input
input-schema: request.critic.v1
output-schema: outcome.critic-report.v1
wait: await
```

### join

```phenix-state
kind: join
policy: all-success
```

### synthesize

```phenix-state
kind: invoke
run: agent.qa-synthesizer
input: qa.synthesize.input
input-schema: request.qa-synthesis.v1
output-schema: outcome.qa-report.v1
wait: await
```

### return

```phenix-state
kind: return
output: qa.output
output-schema: outcome.qa-report.v1
```

## Transitions

| From | To | When | Max traversals |
|---|---|---|---|
| `checks` | `fanout` | | |
| `fanout` | `repo` | | |
| `fanout` | `tests` | | |
| `fanout` | `architecture` | | |
| `fanout` | `security` | | |
| `repo` | `join` | | |
| `tests` | `join` | | |
| `architecture` | `join` | | |
| `security` | `join` | | |
| `join` | `synthesize` | | |
| `synthesize` | `return` | | |
