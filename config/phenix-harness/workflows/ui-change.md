# Legacy UI change workflow

```phenix-workflow
id: workflow.ui-change
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `inspect` | | `scout` | Inspect interaction, rendering, and state paths for {objective} |
| `design` | `inspect` | `architect` | Specify layout, focus, input, and update invariants for {objective} |
| `implement` | `design` | `implementer` | Implement the UI change for {objective} |
| `scenarios` | `implement` | `tester` | Exercise framework-appropriate UI scenarios for {objective} |
| `critique` | `scenarios` | `critic` | Review interaction quality and state consistency for {objective} |
| `finalize` | `critique` | `finalizer` | Produce the UI change handoff for {objective} |
