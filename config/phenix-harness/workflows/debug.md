# Legacy debug workflow

```phenix-workflow
id: workflow.debug
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `reproduce` | | `reproducer` | Reproduce {objective} and collect concrete evidence |
| `diagnose` | `reproduce` | `critic` | Establish the root cause of {objective} |
| `implement` | `diagnose` | `implementer` | Apply the bounded root-cause repair for {objective} |
| `regression` | `implement` | `tester` | Exercise the original scenario and relevant regressions for {objective} |
| `finalize` | `regression` | `finalizer` | Summarize causal and regression evidence for {objective} |
