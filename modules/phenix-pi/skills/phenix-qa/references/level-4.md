# Level 4 — Module and Package Architecture

Determine whether the implementation follows the repository's architectural boundaries.

## Pre-review context

Before making architectural claims, read:

- Architecture documentation (`docs/architecture/`, `ARCHITECTURE.md`, design docs).
- Repository-level instructions (`AGENTS.md`, `CONTRIBUTING.md`).
- Package manifests (`package.json`, `Cargo.toml`, module descriptors).
- Module boundaries and public interfaces.
- Representative neighboring implementations.
- Dependency graph reports (if available).
- Existing architectural tests or lint rules (e.g., `eslint-plugin-import`, `cargo-deny`).

## Inspection points

- Dependency direction (do high-level modules depend on low-level?).
- Layer boundaries (presentation → application → domain → infrastructure).
- Package boundaries (public API surface vs. internal).
- Module ownership and cohesion.
- Cyclic dependencies (direct and transitive).
- Cross-layer imports (e.g., domain importing infrastructure).
- Public versus internal APIs (are internals leaked?).
- Domain logic leaking into transport layers.
- Persistence logic leaking into domain code.
- UI or presentation logic leaking into core logic.
- Infrastructure details leaking through abstractions.
- Runtime behavior implemented inside prompts or configuration.
- Deterministic validation delegated to probabilistic components (e.g., LLM calls).
- State transitions distributed across unrelated modules.
- Parallel implementations of the same responsibility.
- Service locator patterns (hidden dependency resolution).
- Global mutable state.
- Hidden side effects in ostensibly pure functions.
- Boundary validation location.
- Dependency inversion adherence.
- Adapter and port boundary clarity.
- Excessive dependency fan-in or fan-out.

## Monolith classification

A file is not monolithic merely because it is large. Classify as a monolith only when evidence shows multiple unrelated responsibilities:

- Several independent dependency clusters.
- Multiple unrelated state machines.
- Several distinct reasons to change.
- Broad coordination across unrelated subsystems.
- Unrelated public APIs.
- High complexity concentration across separate domains.

## Finding classification

| Classification | Description |
|----------------|-------------|
| Direct architecture violation | Clearly violates documented boundaries. |
| Strong architectural risk | High confidence of boundary problem even without explicit documentation. |
| Suspicious deviation | Requires judgment; may be acceptable. |
| Intentional exception | Deviation that is deliberate and justified. |
| Future design opportunity | Not a problem now, but worth tracking for future refactoring. |
| Not enough evidence | Cannot determine without more context. |
