---
name: phenix-subagents
description: Use real isolated Phenix subagents with typed handoffs, fixed role transitions, runtime model routing, and authoritative verification.
---

# Phenix subagents

Use `phenix_delegate` only when delegation adds value. Trivial or mechanical work may remain in the root session.

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
