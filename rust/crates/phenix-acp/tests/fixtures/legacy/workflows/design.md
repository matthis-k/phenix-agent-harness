# Legacy design workflow

```phenix-workflow
id: workflow.design
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `inspect` | | `scout` | Inspect requirements, constraints, and reusable mechanisms for {objective} |
| `alternatives` | `inspect` | `planner` | Develop alternatives and an executable plan for {objective} |
| `architecture` | `alternatives` | `architect` | Evaluate ownership, interfaces, and data flow for {objective} |
| `critique` | `architecture` | `critic` | Challenge assumptions and failure modes for {objective} |
| `finalize` | `critique` | `finalizer` | Produce the decision-oriented design handoff for {objective} |
