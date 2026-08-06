# Legacy implementation workflow

```phenix-workflow
id: workflow.implement
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `estimate` | | `difficulty-estimator` | Estimate the difficulty of {objective} |
| `plan` | `estimate` | `planner` | Produce an executable plan for {objective} |
| `implement` | `plan` | `implementer` | Apply the implementation for {objective} |
| `verify` | `implement` | `verifier` | Independently verify the implementation for {objective} |
