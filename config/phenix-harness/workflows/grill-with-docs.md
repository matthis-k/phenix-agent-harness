# Alignment grilling with durable context

```phenix-workflow
id: workflow.grill-with-docs
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `inspect` | | `scout` | Inspect the repository, existing CONTEXT files, ADRs, tests, and implementation so questions already answered by evidence are resolved before discussing {objective} |
| `grill` | `inspect` | `coordinator` | Stress-test {objective} one unresolved decision at a time, resolving prerequisite decisions first and giving a recommended answer for each question; do not batch a questionnaire |
| `model` | `grill` | `architect` | Normalize the resolved vocabulary for {objective}, distinguish domain terms from implementation details, and identify only hard-to-reverse surprising decisions that merit ADRs |
| `record` | `model` | `implementer` | Record only settled vocabulary and durable decisions for {objective} in the appropriate CONTEXT and ADR documents; do not implement the feature |
| `verify` | `record` | `verifier` | Verify the recorded context for {objective} matches the resolved decisions, uses repository vocabulary consistently, and contains no speculative implementation commitments |
