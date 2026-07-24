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
```

### fanout

```phenix-state
kind: local
title: Start independent QA branches
operation: local.noop
input: input.identity
```

### repo

```phenix-state
kind: invoke
title: Review repository structure and correctness
run: agent.scout
input: qa.repo.input
wait: await
```

### tests

```phenix-state
kind: invoke
title: Interpret deterministic checks and coverage gaps
run: agent.tester
input: qa.tests.input
wait: await
```

### architecture

```phenix-state
kind: invoke
title: Review architecture and module boundaries
run: agent.architect
input: qa.arch.input
wait: await
```

### security

```phenix-state
kind: invoke
title: Review security and trust boundaries
run: agent.critic
input: qa.security.input
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
wait: await
```

### return

```phenix-state
kind: return
output: qa.output
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
