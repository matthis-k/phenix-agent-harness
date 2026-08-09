# Migration workflow

```phenix-workflow
id: workflow.migrate
entry: inventory
```

## States

| Key | Kind | Role | Required | Join | Objective | Next |
|---|---|---|---|---|---|---|
| `inventory` | `invoke` | `scout` | `required` | `any` | Inventory contracts, providers, consumers, and compatibility obligations affected by {objective}. | `plan` |
| `plan` | `invoke` | `planner` | `required` | `any` | Produce one ordered migration plan for {objective} from states.inventory.output. | `implement` |
| `implement` | `invoke` | `implementer` | `required` | `any` | Execute the migration and cleanup for {objective} using states.plan.output as the authoritative plan. | `audit` |
| `audit` | `invoke` | `critic` | `required` | `any` | Independently audit migrated consumers and obsolete interfaces for {objective}. Return JSON with decision set to accept, repair, or fail and actionable findings. | `accept if output.decision = accept; repair if output.decision = repair; fail if output.decision = fail` |
| `repair` | `invoke` | `implementer` | `required` | `any` | Repair only the migration audit findings for {objective}; do not reopen the migration plan. | `recheck` |
| `recheck` | `invoke` | `critic` | `required` | `any` | Recheck only the repaired migration findings for {objective}. Return JSON with decision set to accept, repair, or fail. | `accept if output.decision = accept; fail if output.decision = repair; fail if output.decision = fail` |
| `accept` | `return` | | `optional` | `any` | Migration accepted for {objective}; return the deterministic migration handoff from accumulated artifacts. | |
| `fail` | `fail` | | `optional` | `any` | Migration acceptance failed for {objective} after the bounded repair budget. | |
