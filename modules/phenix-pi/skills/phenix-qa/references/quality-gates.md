# Quality Gates

Progressive gates applied during the review. Each gate builds on evidence from its level and below.

## Gate configuration

Gates may be configured per project. The default configuration is:

```yaml
gates:
  correctness:
    enabled: true
    blockOnFail: true
  changeSafety:
    enabled: true
    blockOnFail: false
  designConsistency:
    enabled: true
    blockOnFail: false
  architecture:
    enabled: true
    blockOnFail: true
  productionReadiness:
    enabled: true
    blockOnFail: false
```

A project may disable a gate entirely if the gate concept does not apply (e.g., a library may disable the production-readiness gate).

## Gate A — Correctness

**Level 0 evidence.**

Fail when:

- The code does not parse.
- The code does not compile or type-check.
- **Required** tests fail.
- **Required** schemas are invalid.
- The build is broken.

Do not fail for:

- Warnings (unless the project treats warnings as errors).
- Pre-existing test failures outside the review scope.
- Optional lint rules that the project does not enforce.

## Gate B — Change Safety

**Level 1 evidence + Level 2 review.**

Fail or require review when:

- The change introduces high-severity complexity (e.g., cyclomatic > 20 in new code).
- The change introduces unsafe boundary handling (unchecked casts, null assertions, swallowed errors).
- The change introduces a dependency cycle.
- The change introduces a major duplication block (> 10 lines copied from existing code without abstraction).
- The change reduces coverage in a high-risk area.
- The change creates unhandled state or protocol cases (e.g., new enum variant not handled in exhaustiveness checks).

## Gate C — Design Consistency

**Level 2 + Level 3 evidence.**

Require review when:

- The change bypasses an established pattern without explanation.
- It introduces a competing abstraction when one already exists.
- It mixes responsibilities (e.g., a function that validates, transforms, and persists).
- It expands a public API unnecessarily.
- It creates a local design that is inconsistent with equivalent modules.

## Gate D — Architecture

**Level 4 evidence.**

Fail or require explicit exception when:

- Dependency direction is violated (e.g., domain imports infrastructure).
- A forbidden layer import is introduced.
- Domain, infrastructure, transport, and presentation concerns are improperly mixed.
- A module becomes responsible for unrelated subsystems.
- A runtime boundary is bypassed.
- A new architectural cycle is introduced.

## Gate E — System and Production Readiness

**Level 5 + Level 6 + Level 7 evidence.**

Fail or require explicit approval when:

- The change is not backward compatible where compatibility is required.
- Retry, timeout, cancellation, or failure behavior is unsafe.
- Data migration requirements are unhandled.
- The change is not observable enough to operate.
- Security or trust-boundary issues remain unresolved (Level 7 critical/high findings).

## Gate result semantics

| Result | Meaning |
|--------|---------|
| PASS | All checks passed. No action required. |
| REVIEW | Issues found that require reviewer judgment. May proceed with documented acceptance. |
| FAIL | Blocking issues found. Must be resolved before approval. |
| NOT_RUN | Gate was not executed (e.g., disabled, or lower-level failure prevented analysis). |
