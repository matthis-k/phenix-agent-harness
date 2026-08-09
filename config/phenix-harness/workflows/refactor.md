# Refactor workflow

```phenix-workflow
id: workflow.refactor
entry: characterize
```

## States

| Key | Kind | Role | Required | Join | Objective | Next |
|---|---|---|---|---|---|---|
| `characterize` | `invoke` | `scout` | `required` | `any` | Capture public behavior, contracts, and invariants for {objective}. | `architecture` |
| `architecture` | `invoke` | `architect` | `required` | `any` | Define intended ownership and dependency structure for {objective}; remain the design owner, not the acceptance reviewer. | `implement` |
| `implement` | `invoke` | `implementer` | `required` | `any` | Apply the behavior-preserving refactor for {objective} using states.architecture.output. | `review` |
| `review` | `invoke` | `critic` | `required` | `any` | Independently review semantic preservation and architecture conformance for {objective}. Return JSON with decision set to accept, repair, or fail and actionable findings. | `accept if output.decision = accept; repair if output.decision = repair; fail if output.decision = fail` |
| `repair` | `invoke` | `implementer` | `required` | `any` | Repair only the independent review findings for {objective}; preserve the architecture contract. | `recheck` |
| `recheck` | `invoke` | `critic` | `required` | `any` | Recheck only the repaired refactor findings for {objective}. Return JSON with decision set to accept, repair, or fail. | `accept if output.decision = accept; fail if output.decision = repair; fail if output.decision = fail` |
| `accept` | `return` | | `optional` | `any` | Refactor accepted for {objective}; return the accumulated behavior and review evidence. | |
| `fail` | `fail` | | `optional` | `any` | Refactor acceptance failed for {objective} after the bounded repair budget. | |
