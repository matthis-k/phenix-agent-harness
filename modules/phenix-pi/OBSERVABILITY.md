# Phenix run observability

Phenix exposes deterministic execution telemetry without routing it through another model.

## Live views

- `/phenix runs` shows the complete live run tree with current activity and recent facts.
- `/phenix facts` shows the merged chronological fact history for the full session tree.
- Append `off` to hide the active widget.
- Append `--once` for a static text snapshot.
- Append `--json` for the complete structured fact projection.
- `/phenix facts --clipboard` pipes the complete text history to `wl-copy`.
- `/phenix facts --clipboard <program> [args...]` spawns another program directly.
- Use an explicit shell program, for example `sh -c '...'`, only when shell composition is genuinely required.
- `/phenix facts --file <file>` writes the complete text history to a relative or absolute path with private file permissions.

Clipboard and file exports use the same complete ANSI-free plain-text history. Export operations report their fact count and destination, and failures do not modify the live view.

## Semantic colors

The live views and status surfaces use theme-aware semantic colors:

- active work: accent
- waiting or repair: warning
- successful or completed: success
- failed: error
- cancelled: muted/error distinction
- agent-reported facts: warning
- deterministically derived facts: secondary
- IDs, timestamps, and tree guides: muted

Exports remain uncolored.

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
