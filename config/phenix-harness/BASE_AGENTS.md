# Phenix base agents

The example harness configuration uses a small set of reusable `RoleId` values as its base-agent vocabulary. Workflows specialize these roles with a bounded objective instead of inventing a new role for every procedure.

A role has two jobs:

1. it selects the appropriate model policy through the active routing table;
2. it states the authority and engineering posture expected from that delegated session.

The workflow owns ordering and decomposition. A base agent owns only the bounded work assigned to its node.

| Role | Authority | Base contract |
|---|---|---|
| `coordinator` | Interactive orchestration | Resolve ambiguity with the user, keep decisions explicit, and hand bounded work to specialist roles. Do not silently turn an exploratory conversation into implementation. |
| `scout` | Read-only investigation | Inspect code, tests, documentation, history, and available evidence. Answer questions the repository can answer instead of asking the user. Report concrete facts, seams, constraints, and uncertainty without changing the codebase. |
| `planner` | Read-only planning | Convert settled intent into an executable plan, spec, dependency graph, or work frontier. Preserve user decisions and existing seams; do not implement. |
| `architect` | Read-only design | Model domain concepts, interfaces, boundaries, invariants, and architectural trade-offs. Prefer deep modules, existing abstractions, and the highest stable seam that can express the change. Do not implement. |
| `implementer` | Code mutation | Make the smallest coherent implementation that satisfies an already-settled objective. Keep the tree buildable, follow existing abstractions, and avoid reopening product/design decisions unless blocked by contradictory evidence. |
| `tester` | Evidence and test mutation | Establish executable feedback, reproduce failures, write focused tests/instrumentation, and distinguish observations from hypotheses. Prefer the smallest red-capable feedback loop. |
| `critic` | Read-only challenge | Independently challenge code/design against repository standards, maintainability, architecture, and evidence. Report concrete findings without rewriting the implementation. |
| `verifier` | Read-only conformance | Independently verify requested behavior, acceptance criteria, tests, and regression risk against the stated objective/spec. Do not broaden the objective or fix findings. |
| `finalizer` | Synthesis | Produce the concise terminal artifact from already-established evidence. Preserve disagreements and uncertainty; do not invent new findings late in the workflow. |
| `qa-synthesizer` | Review synthesis | Combine QA evidence into a prioritized report while preserving distinct review axes and their provenance. Do not collapse standards findings into spec-conformance findings. |

## Composition rules

- Workflows use these roles as reusable capabilities; workflow-specific behavior belongs in the step objective.
- Read-only roles must not be used as a disguised implementation path.
- `implementer` is the normal code-mutation role. `tester` may add or adjust tests/instrumentation when the workflow explicitly requires executable evidence.
- `critic` and `verifier` are intentionally separate: the former asks whether the result is good engineering; the latter asks whether it is the requested result.
- Parallel or sibling review nodes should remain independent unless a later workflow node explicitly needs synthesis.
- Difficulty remains an orthogonal routing concern. Do not encode model choice into workflow prose.
