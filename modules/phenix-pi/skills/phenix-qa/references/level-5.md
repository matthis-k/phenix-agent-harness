# Level 5 — System and Integration Design

Determine whether the code behaves correctly as part of the wider system.

## Inspection points

- API compatibility (does the change break existing consumers?).
- Data-contract compatibility (schemas, protobuf, GraphQL, database schemas).
- Backward compatibility (is the change safe to deploy without migration?).
- Schema evolution (are new fields optional? are removed fields deprecated first?).
- Persistence migration requirements.
- Idempotency (can the operation be safely repeated?).
- Retry safety (what happens if the operation is retried?).
- Timeout handling (are there timeouts? are they appropriate? is cancellation handled?).
- Cancellation behavior (is the operation safely cancellable mid-flight?).
- Concurrency (shared state, locking, atomicity).
- Race conditions.
- Ordering assumptions (is message/signal ordering relied upon?).
- Transaction boundaries (are multiple mutations atomic where needed?).
- Partial-failure behavior (what happens when one of N operations fails?).
- Resource cleanup (files, connections, handles on failure paths).
- Process termination (graceful shutdown, in-flight operation handling).
- Memory and file-handle ownership.
- Network failure handling (timeouts, retries, circuit breakers).
- Distributed-state assumptions.
- Event duplication handling.
- Event loss tolerance.
- Reentrancy (can the function be called while already executing?).
- Cache invalidation strategy.
- Configuration compatibility (new required config, changed defaults).
- Feature-flag behavior (does the flag gate correctly? is the fallback safe?).
- Rollback behavior (can the deployment be safely rolled back?).

## Systemically unsafe patterns

Pay particular attention to code that is locally clean but systemically unsafe:

- A function is readable but not idempotent under retry.
- A new enum case is added but not handled by older consumers.
- A new field changes serialization compatibility.
- A state transition is valid locally but violates process-level ordering.
- A new dependency introduces a cycle between services.
- A timeout is added without cancellation.
- A retry is added around a non-repeatable operation (e.g., payment processing).
