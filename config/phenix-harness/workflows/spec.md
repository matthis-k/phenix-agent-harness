# Spec synthesis

```phenix-workflow
id: workflow.spec
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `context` | | `scout` | Recover the settled conversation, codebase constraints, domain vocabulary, and existing behavior relevant to {objective}; do not start a new interview |
| `seams` | `context` | `architect` | Identify the smallest stable interfaces and acceptance seams for {objective}, preferring existing seams and the highest useful seam over new low-level boundaries |
| `spec` | `seams` | `planner` | Synthesize an implementation-independent specification for {objective} with concrete user-visible behavior, invariants, acceptance criteria, non-goals, and the agreed seams |
| `verify` | `spec` | `verifier` | Verify the specification for {objective} is grounded in settled intent, uses project vocabulary, is testable at durable seams, and does not invent unresolved product decisions |
