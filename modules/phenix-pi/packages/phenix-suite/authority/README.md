# Execution authority

This package contains the runtime-neutral source of truth for managed Phenix work.

- `types.ts` defines objective, node, handle, event, assurance, and mutation contracts.
- `service.ts` owns revisioned lifecycle transitions, idempotency, recovery, and projections.
- `store.ts` supplies in-memory and atomic file persistence.
- `assurance.ts` separates result assurance from model difficulty.
- `workflow-bridge.ts` projects the existing workflow evaluator into authority actions.
- `task-projection.ts` projects capability-scoped task events into execution nodes.
- `registry.ts` owns one durable authority per project root.

Only bridge and integration modules may depend on Pi-facing or workflow-adapter types. The core files remain transport-neutral.
