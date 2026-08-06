# Legacy refactor workflow

```phenix-workflow
id: workflow.refactor
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `characterize` | | `scout` | Capture public behavior and invariants for {objective} |
| `architecture` | `characterize` | `architect` | Define intended ownership and dependency structure for {objective} |
| `implement` | `architecture` | `implementer` | Apply the behavior-preserving refactor for {objective} |
| `review` | `implement` | `architect` | Review architecture and semantic preservation for {objective} |
| `finalize` | `review` | `finalizer` | Produce the refactor handoff for {objective} |
