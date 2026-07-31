# Review workflow

```phenix-workflow
id: workflow.review
description: Run the invariant read-only review and deterministic evidence pipeline exposed by workflow.qa under a task-oriented review route.
input: request.objective
output: outcome.qa-report
entry: review
timeout-ms: 3000000
max-node-runs: 4
max-parallelism: 1
```

## Flow

```mermaid
flowchart LR
    review[[workflow.qa]] --> return([Return review report])
```

## States

### review

```phenix-state
kind: invoke
title: Run the complete review pipeline
run: workflow.qa
input: input.identity
input-schema: request.objective
output-schema: outcome.qa-report
wait: await
```

### return

```phenix-state
kind: return
output: review.output
output-schema: outcome.qa-report
```

## Transitions

| From | To | When | Max traversals |
|---|---|---|---|
| `review` | `return` | | |
