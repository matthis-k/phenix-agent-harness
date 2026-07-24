# Phenix run observability

Phenix exposes deterministic execution telemetry without routing it through another model.

## Live dashboard

- `/phenix status` opens the live session dashboard.
- `/phenix status off` hides the active widget.
- `/phenix status --once` renders one static dashboard snapshot.
- `/phenix status --json` renders the complete structured status projection, including durable storage locations.
- `/phenix status --expanded` expands completed execution subtrees for inspection.

The default dashboard is a compact execution overview. Its header combines the root profile, model set, difficulty, active descendant count, diagnostic health, and integration health. The synthetic root run is omitted. Every visible agent or workflow occupies one row containing its semantic role, state, dimmed concrete provider/model and thinking level, and current activity when the run is active. Completed subtrees collapse automatically and summarize how many descendants completed or ended exceptionally. Waiting, active, and failed branches remain expanded.

The dashboard retains a three-line deduplicated recent-facts tail for quick context. `/phenix facts` remains the complete chronological history and export surface. Storage paths are omitted from the default text dashboard and remain available through `/phenix status --json` and diagnostic export commands.

## Fact history

- `/phenix facts` shows the merged chronological fact history for the full session tree.
- Append `off` to hide the active widget.
- Append `--once` for a static text snapshot.
- Append `--json` for the complete structured fact projection.
- `/phenix facts --clipboard` pipes the complete text history to `wl-copy`.
- `/phenix facts --clipboard <program> [args...]` spawns another program directly.
- Use an explicit shell program, for example `sh -c '...'`, only when shell composition is genuinely required.
- `/phenix facts --file <file>` writes the complete text history to a relative or absolute path with private file permissions.

Clipboard and file exports use the same complete ANSI-free plain-text history. Export operations report their fact count and destination, and failures do not modify the live view.

## Structured diagnostic logs

`/phenix logs` reads the root-scoped structured diagnostic stream. Severity options are thresholds:

- `--trace`: trace, info, warning, and error
- `--info`: info, warning, and error; this is the default
- `--warning` or `--warn`: warning and error
- `--error`: error only

The interactive view renders the latest matching entries in a grepable single-line form. `/phenix logs --json` exposes the matching structured records. `/phenix logs <severity> --copy [program]` pipes the complete filtered JSONL stream to `wl-copy` or another directly spawned program. `/phenix logs <severity> --file <file>` writes the complete filtered JSONL stream with private permissions.

Scopes are stable lowercase dot-separated identifiers such as `run.lifecycle.failed`, `model.routing.resolved`, `workflow.node.entered`, and `tool.execution.started`. Runtime IDs, model names, durations, exit states, counts, and other short scalar fields stay inline. Large strings, context, inputs, outcomes, nested reports, and provider bodies are stored once as private content-addressed artifacts and represented by `artifact:sha256:<digest>` references. Resolve one with `/phenix logs --resolve <reference>`.

The diagnostic stream is not canonical execution state. The append-only run ledger remains authoritative; diagnostics are a durable reconstruction aid derived from runtime boundaries and domain events.

## Semantic colors

The live views and status surfaces use theme-aware semantic colors:

- active work: accent
- waiting or repair: warning
- successful or completed: success
- failed: error
- cancelled: muted/error distinction
- concrete model and thinking metadata: muted in the compact status tree
- agent-reported facts: warning
- deterministically derived facts: secondary
- IDs, timestamps, paths, and tree guides: muted

Exports remain uncolored and retain explicit state labels and symbols so meaning does not depend on color.

## Activity and facts

Current activity answers what a run is doing now. Fact history records concrete events in sequence and is rebuilt from the JSONL run ledger during recovery.

Fact reliability is rendered as:

- `✓` observed directly by the runtime or tool lifecycle
- `≈` derived deterministically from observed data
- `!` reported by an agent and not independently verified

Tool arguments are reduced to bounded summaries. Paths are repository-relative where possible. Raw tool output is never stored in activity or fact events. Durable command summaries omit shell bodies and redact environment assignments, credentials, authorization headers, URL credentials, and secret-bearing flags or query parameters.

## Agent progress

Child agents may call `phenix_progress` when their phase, current target, hypothesis, or next action materially changes. The report updates only run activity and fact projections used by the TUI. It is not sent to the root or parent model and is not inserted into the root conversation transcript.

## Structured presentation

Operational child agents may call `phenix_present` when they discover a warning, high-severity, or critical issue that should be visible before the run finishes.

Presentation input is bounded to a title, summary, optional subject, and at most eight short evidence items. The runtime derives a deterministic presentation fingerprint from the source run and normalized content. The first occurrence is recorded as a reported `finding-reported` fact; duplicate occurrences are acknowledged without another fact or notification.

The root notifier handles the first occurrence in two ways:

1. it renders the bounded notice directly in the root UI;
2. it delivers the same notice to the root model on its next turn so the root can inspect, reroute, stop, or request input.

A presentation is an attention signal, not a replacement for the child's final typed outcome. It must not be used for ordinary progress, repeated commentary, or raw command output.

## Model-facing result volume

Awaited run and dispatch tools return compact projections by default. Complete outcomes remain in the canonical run ledger and are admitted to a model only through an explicit `phenix_handle` result view. Tool-result details report source, inline, and omitted byte counts so transport savings remain observable without reintroducing the omitted payload.
