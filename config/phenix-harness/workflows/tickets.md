# Tracer-bullet work decomposition

```phenix-workflow
id: workflow.tickets
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `prefactor` | | `architect` | Inspect {objective} for changes that should make the implementation easy before making the easy change, and identify any wide mechanical refactor that requires expand-migrate-contract rather than ordinary slicing |
| `slice` | `prefactor` | `planner` | Decompose {objective} into independently verifiable tracer-bullet vertical slices with explicit blocking edges; each ordinary slice should cut through all required layers rather than representing one horizontal layer |
| `challenge` | `slice` | `critic` | Challenge the decomposition for {objective}: merge needless fragmentation, split oversized slices, verify dependency direction, and reject horizontal slices unless a wide-refactor exception requires staged migration |
| `publish` | `challenge` | `finalizer` | Produce the final blocker-first ticket set for {objective}, including acceptance evidence and explicit dependencies so the unblocked frontier is mechanically understandable |
