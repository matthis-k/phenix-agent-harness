---
name: phenix-subagents
description: Use real isolated Phenix subagents with typed handoffs, fixed role transitions, runtime model routing, and authoritative verification.
---

# Phenix subagents

Use `phenix_delegate` only when delegation adds value. Trivial or mechanical work may remain in the root session.

`phenix_delegate` creates **real isolated subagents** — each delegation spawns a separate child process with its own model, thinking level, tools, verification commands, and critic gates. The runtime owns model selection, so the root never chooses the concrete model for a child. Raw `subagent` calls are blocked to prevent bypassing this isolation.

## Workflow orchestration

When running as a Phenix workflow coordinator (root session with a Phenix model set), follow this pipeline for non-trivial tasks:

```text
1. Plan    → delegate to planner subagent
2. Review  → delegate to architect subagent (if cross-cutting)
3. Execute → delegate to implementer subagent
4. Verify  → delegate to critic subagent
5. Fix     → delegate back to implementer if critic finds blockers
6. Repeat  → verify again until clean
```

Each step produces a **structured handoff** (via typed `outputSchema`) that feeds into the next. The root coordinator:
- Reads each child's structured output
- Decides whether to proceed, loop back, or stop
- Reports final results to the user

Never simulate a subagent role by switching personas within the root session. Every role transition must go through `phenix_delegate`.

## Atomic call

Provide:

- `role`: scout, planner, architect, implementer, tester, critic, or finalizer.
- `task`: a bounded objective with the relevant context and scope.
- `outputSchema`: a strict JSON Schema for the handoff.
- `requirements`: the obligations the child must cover.
- `profile`: optional upward-only difficulty/risk hints. The runtime derives and clamps the final profile.
- `mode`: normally `await`; use `background` only for independent root-level work.

Do not choose a concrete model, thinking level, tools, verification commands, acceptance level, or retry count. The runtime owns those decisions.

## Legal child roles

- scout → scout
- planner → scout, architect, critic
- architect → scout, critic
- implementer → scout, tester, critic
- tester → scout
- critic → scout, tester
- finalizer → critic

The root may spawn any role. Nested background work is disallowed so child tasks remain structured and joined.

## Handoff discipline

Require schemas that represent the actual downstream need rather than free-form prose. Include requirement IDs or coverage fields when completeness matters. A child must call `structured_output`; invalid values are rejected with exact schema errors and may be repaired in the same child session. Phenix then validates again, runs immutable verification commands itself, and applies an independent typed critic gate. A failed runtime handoff receives the exact failures in one bounded repair attempt.

Use `phenix_agent` to await, poll, inspect, cancel, or display the persistent semantic tree for background handles.
