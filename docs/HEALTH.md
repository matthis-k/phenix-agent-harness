# Phenix health diagnostics

`/phenix health` is a read-only, deterministic operator diagnostic. It does not dispatch agents, execute workflows, mutate runtime state, or invoke shell commands.

## Commands

```text
/phenix health
/phenix health integrations
/phenix health models
/phenix health definitions
/phenix health runtime
/phenix health storage
/phenix health [topic] --json
```

The aggregate command renders one compact line per topic. A topic command renders the complete bounded detail for that subsystem. `--json` returns the same structured report without terminal formatting.

## States

- `healthy`: the inspected contract is available and internally consistent.
- `degraded`: the subsystem remains usable but has partial failures, warnings, or persisted dynamic-workflow drift.
- `unavailable`: the required runtime or storage resource cannot currently be used.
- `misconfigured`: the runtime configuration contradicts its declared contract, such as a missing selected model set, invalid workflow definitions, or absent persistence paths.

The aggregate state is the most severe section state in this order:

```text
healthy < degraded < unavailable < misconfigured
```

## Topics

### Integrations

Reports each configured Pi integration as loaded or failed. Partial failure is degraded; total failure is unavailable; an empty integration inventory is misconfigured.

### Models

Reports every Phenix model set registered in Pi and identifies the currently selected set. Missing optional sets degrade the report. A missing selected set is misconfigured.

### Definitions

Runs the sealed definition catalog validator and reports root-visible definitions. It also inspects persisted dynamic workflow runs for `workflow_definition_drift` and `workflow_definition_invalid` failures.

### Runtime

Reports the root run state, active run count, event sequence, and diagnostic counts. Historical diagnostic entries are evidence and do not by themselves make the current runtime unhealthy.

### Storage

Checks the root event ledger, diagnostic log, and diagnostic artifact directory. The artifact directory may be absent while the artifact count is zero.

## Bounded execution

Each topic has an independent timeout. A slow or failed topic becomes `unavailable` without blocking the remaining health report. Probe errors are converted to bounded details rather than thrown through the command adapter.
