# Long-horizon wayfinding

```phenix-workflow
id: workflow.wayfinder
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `recon` | | `scout` | Reconnoiter {objective} across the repository and existing plans, identifying known constraints, unknowns, irreversible decisions, dependencies, and evidence that can be resolved without implementation |
| `map` | `recon` | `planner` | Build a decision and investigation map for {objective} that is small enough to navigate across multiple sessions; separate questions that block direction from implementation work and identify the current decision frontier |
| `resolve` | `map` | `architect` | Resolve the highest-leverage architectural and domain decisions for {objective} from available evidence, recording trade-offs and leaving genuinely user-owned decisions explicit rather than guessing |
| `frontier` | `resolve` | `verifier` | Verify the wayfinding map for {objective} is coherent, names remaining uncertainty, has explicit dependencies, and is ready to hand off to alignment, specification, and ticket workflows without prematurely implementing anything |
