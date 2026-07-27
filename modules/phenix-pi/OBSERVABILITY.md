# Phenix observability

Phenix records deterministic execution telemetry without invoking another model.

## Dashboard

- `/phenix` opens the full-screen UI on Status.
- `/phenix ui <view>` opens Status, Runs, Facts, or Catalog directly.
- `/phenix status` prints a compact static overview.
- `/phenix status --json` prints the complete status data, including storage locations.
- `/phenix status --expanded` expands completed run subtrees.

The status overview shows the root profile, selected model set, difficulty, active descendants, diagnostics, integrations, current execution, and recent facts. Completed subtrees collapse by default; active, waiting, and failed branches remain visible.

## Facts

- `/phenix facts` prints the complete chronological fact history.
- `/phenix facts --json` prints structured facts.
- `/phenix facts --clipboard` pipes plain text to `wl-copy`.
- `/phenix facts --clipboard <program> [args...]` uses another executable directly.
- `/phenix facts --file <file>` writes plain text with private permissions.

Exports are complete, uncolored, and ordered across the full run tree.

Fact reliability symbols are:

- `✓`: observed directly;
- `≈`: derived from observed data;
- `!`: reported by an agent and not independently verified.

## Logs

`/phenix logs` reads structured diagnostics. Severity options are thresholds:

- `--trace`: trace and above;
- `--info`: info and above; default;
- `--warning` or `--warn`: warning and error;
- `--error`: error only.

Use `--json` for structured records, `--copy [program]` for filtered JSONL on standard input, and `--file <file>` for a private JSONL export. Resolve an artifact reference with `/phenix logs --resolve <reference>`.

Diagnostic scopes are stable lowercase dotted names. Short values remain inline. Large or nested values are stored once as private content-addressed artifacts and replaced by `artifact:sha256:<digest>` references. Secret-bearing fields are redacted before storage.

The event ledger remains the complete run history. Logs are supporting diagnostic evidence.

## Activity and progress

Current activity describes what a run is doing now. Facts record completed or observed events. Tool arguments are reduced to bounded summaries, paths are repository-relative where possible, and raw tool output is not stored as activity or facts.

`phenix_progress` updates the current activity and fact projections. It does not notify the parent or root model.

## Material findings

Operational child agents may call `phenix_present` for a warning, high-severity, or critical issue that should be visible before completion.

A presentation contains a title, summary, optional subject, and bounded evidence. The first occurrence is recorded as a reported fact, shown in the root UI, and delivered to the root model on its next turn. Repeated identical presentations are acknowledged without another notification.

Presentations are not a progress stream and do not replace the final typed result.

## Result volume

Awaited run and dispatch tools return compact results by default. Complete outcomes remain available through explicit `phenix_handle` result views. Tool results report source, inline, and omitted byte counts.
