# Legacy migration workflow

```phenix-workflow
id: workflow.migrate
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `inventory` | | `scout` | Inventory contracts, providers, and consumers affected by {objective} |
| `plan` | `inventory` | `planner` | Produce an ordered migration plan for {objective} |
| `implement` | `plan` | `implementer` | Execute the migration and cleanup for {objective} |
| `audit` | `implement` | `critic` | Audit migrated consumers and obsolete interfaces for {objective} |
| `finalize` | `audit` | `finalizer` | Produce the migration handoff for {objective} |
