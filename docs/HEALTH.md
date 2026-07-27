# Phenix health diagnostics

`/phenix health` performs bounded, read-only checks. It does not dispatch agents, run workflows, mutate state, or execute shell commands.

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

The aggregate command prints one line per topic. A topic command prints its detailed result. `--json` returns the same data without terminal formatting.

## States

- `healthy`: available and consistent.
- `degraded`: usable with warnings or partial failures.
- `unavailable`: a required resource cannot be used.
- `misconfigured`: the selected configuration is invalid or incomplete.

Severity order:

```text
healthy < degraded < unavailable < misconfigured
```

## Topics

- **Integrations**: loaded and failed Pi integrations.
- **Models**: registered Phenix model sets and the selected set.
- **Definitions**: bundled definition validation and persisted dynamic-workflow drift.
- **Runtime**: root state, active runs, event sequence, and diagnostic counts.
- **Storage**: event ledger, diagnostic log, and artifact directory.

Each topic has its own timeout. A slow or failed check becomes `unavailable` without blocking the remaining report.
