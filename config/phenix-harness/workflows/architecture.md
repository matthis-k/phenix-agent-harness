# Architecture deepening

```phenix-workflow
id: workflow.architecture
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `inspect` | | `scout` | Map the concrete code paths, abstractions, duplicated knowledge, naming, and dependency direction relevant to {objective}; collect examples rather than proposing changes yet |
| `model` | `inspect` | `architect` | Identify opportunities for {objective} to deepen modules, reduce exposed concepts, improve semantic boundaries, reuse stronger existing abstractions, and align code structure with the domain model |
| `challenge` | `model` | `critic` | Challenge the proposed architecture changes for {objective} against migration cost, accidental abstraction, coupling, ownership, and whether code reduction is actually achieved |
| `plan` | `challenge` | `planner` | Produce a prioritized architecture plan for {objective} with explicit trade-offs, migration containment, validation seams, and a preference for changes that simplify the system rather than merely move code |
