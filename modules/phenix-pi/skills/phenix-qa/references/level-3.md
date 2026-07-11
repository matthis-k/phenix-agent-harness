# Level 3 — Design-Pattern and Convention Consistency

Determine whether equivalent concepts are implemented consistently across the codebase.

## Pattern identification

Before claiming that a pattern exists, identify:

- An explicitly documented rule (e.g., in `CONTRIBUTING.md`, architecture docs, or style guide), **or**
- At least two representative implementations demonstrating the convention.

Do not claim a pattern exists based on a single example.

## Consistency inspection areas

- Dependency injection style.
- Object or service construction.
- Factories and builders.
- Repository and persistence access.
- Error modeling: custom classes, error codes, `Result<T, E>`.
- Result handling: `try/catch` vs. `Result` types vs. error callbacks.
- Asynchronous workflows: `async/await` vs. callbacks vs. streams.
- Cancellation: `AbortSignal`, `CancellationToken`, channel close.
- Retry behavior: which layer retries, backoff strategy.
- Logging: structured vs. string, levels used, context attachment.
- Configuration loading: env vars, files, CLI flags, layered config.
- Serialization: which library, how schemas are validated.
- Boundary validation: where input validation happens.
- State transitions: explicit state machines vs. ad-hoc boolean flags.
- Event handling: event types, dispatch, subscription.
- Command registration: how commands/handlers are wired.
- Plugin registration: discovery and lifecycle.
- Public API shape: function exports, classes, barrel files.
- Naming and exports: naming conventions, re-export patterns.
- Resource ownership and cleanup: who allocates, who frees.
- Test organization: file layout, naming, fixtures, mocking style.

## For every inconsistency, state

1. What the established pattern is.
2. Where that pattern is demonstrated (at least 2 file:line references).
3. Where the reviewed code deviates.
4. Whether the deviation is harmful (does it cause confusion, bugs, or maintenance burden?).
5. Whether the difference appears intentional (e.g., different domain, different constraints).
6. The smallest viable normalization (if harmful).

## Constraints

- Do not enforce visual uniformity between code serving different purposes.
- Pattern consistency is valuable when equivalent concepts should behave predictably.
- A deviation that is deliberate and documented is not a finding.
