# Phenix run observability

Phenix exposes live execution telemetry without routing it through another model.

## Live views

- `/phenix runs` shows the live run tree with each run's current activity and recent facts.
- `/phenix facts` shows the merged chronological fact history for the full session tree.
- Append `off` to hide the active widget.
- Append `--once` for a static text snapshot.
- Append `--json` for the complete structured fact projection.
- `/phenix facts --clipboard` pipes the complete text history to `wl-copy`.
- `/phenix facts --clipboard <command>` pipes it to another shell command, such as `xclip -selection clipboard`.
- `/phenix facts --file <file>` writes the complete text history to a file relative to the current working directory, unless an absolute path is supplied.

The views update from the runtime domain-event stream. They do not poll child sessions or invoke a model.

## Activity and facts

Current activity answers what a run is doing now. Fact history records concrete events in sequence and is rebuilt from the JSONL run ledger during recovery.

Fact reliability is rendered as:

- `✓` observed directly by the runtime or tool lifecycle
- `≈` derived deterministically from observed data
- `!` reported by an agent and not independently verified

Tool arguments are reduced to bounded summaries. Paths are repository-relative where possible, secret-like values are redacted, and raw tool output is not stored in activity or fact events.

## Agent progress

Child agents may call `phenix_progress` when their phase, current target, hypothesis, or next action materially changes. The report updates only the run activity and fact projections used by the TUI. It is not sent to the root or parent model and is not inserted into the root conversation transcript.
