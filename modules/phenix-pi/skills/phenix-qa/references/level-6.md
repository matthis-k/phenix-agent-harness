# Level 6 — Operational and Production Quality

Assess whether the implementation can be safely operated.

## Inspection points

- Logging quality (are important decisions and state transitions logged?).
- Structured diagnostics (are logs parseable? are fields consistent?).
- Error context (do error messages include enough information to diagnose?).
- Metrics (are key operations instrumented?).
- Tracing (can a request be traced across components?).
- Alertability (would an operator notice a failure?).
- Health checks (does the component report its health?).
- Graceful degradation (does the system continue partially when a dependency fails?).
- Feature flags (are risky changes gated?).
- Configuration validation (is config validated at startup?).
- Startup and shutdown behavior (is startup ordered? is shutdown graceful?).
- Recovery behavior (can the component recover from a crash or restart?).
- Rate limiting (is there protection against overload?).
- Backpressure (does the component signal when it is overloaded?).
- Capacity assumptions (are there hidden limits?).
- Resource bounds (memory, connections, file descriptors).
- Sensitive-data logging (are secrets, PII, or tokens ever logged?).
- Secret handling (are secrets in env vars, config files, or hardcoded?).
- Debuggability (can an operator reproduce a failure?).
- Failure visibility (would an operator know what failed and why?).

## Operator questions

Determine whether operators can answer:

- What failed?
- Where did it fail?
- Which input or state caused it?
- Can the failure be correlated across components?
- Is the operation safe to retry?
- Is the system partially degraded?
- Is manual intervention required?

## Scope limitations

Do not demand production telemetry from isolated libraries unless the repository's architecture assigns that responsibility to them. A library should focus on clear error reporting and documentation of failure modes rather than emitting metrics directly.
