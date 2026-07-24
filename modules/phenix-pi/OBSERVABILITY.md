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
