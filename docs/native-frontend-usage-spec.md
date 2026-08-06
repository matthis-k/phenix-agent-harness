# Native frontend usage and UX specification

## Status and scope

This document is the normative product contract for the native Phenix agent frontend. It defines how people use the harness, what the interface communicates, and the acceptance behavior required from the Rust/Ratatui frontend and future adapters such as Neovim.

It is intentionally written from the user's point of view. Internal ACP, gateway, reducer, event-bus, and backend details must not leak into ordinary interactions.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

This specification covers:

- first launch, startup, connection, and authentication;
- starting, continuing, resuming, branching, renaming, and exporting sessions;
- composing prompts, streaming responses, steering, follow-ups, and cancellation;
- models, virtual models, thinking levels, and agent modes;
- run trees, delegated agents, workflows, and objectives;
- tools, terminals, permissions, images, extension dialogs, and notifications;
- compaction, retries, failure recovery, reconnects, and orderly shutdown;
- keyboard, mouse, narrow-terminal, and configurable frontend behavior;
- testable acceptance scenarios for typical and exceptional use.

It does not prescribe backend implementation, orchestration algorithms, model-provider policy, or visual ornamentation.

## Product goal

Phenix should feel like a familiar terminal chat client that happens to expose a capable agent harness.

A new user should be able to launch it, authenticate, type a request, understand what is running, approve consequential actions, and recover interrupted work without learning Phenix's architecture. An experienced user should be able to navigate run trees, steer active agents, inspect exact tool activity, switch sessions, and customize the interface without fighting modal complexity.

The frontend has one dominant workflow:

```text
select context -> type request -> observe progress -> intervene only when useful
```

Everything else supports that loop.

## Familiarity baseline

Phenix follows interaction patterns common to contemporary terminal agents:

- an immediately visible conversation and composer;
- `Enter` to submit and `Shift+Enter` for a newline;
- slash commands for discoverable session-local actions;
- searchable pickers for models, sessions, and commands;
- explicit permission prompts before consequential tool actions;
- automatically persisted, resumable sessions;
- progressive disclosure for tool output, orchestration, and diagnostics;
- stable keyboard navigation with mouse parity;
- clear interruption, retry, and recovery semantics.

Phenix-specific orchestration is additive. It must not replace familiar concepts with protocol or framework vocabulary.

## UX principles

### 1. Chat first

The transcript and composer are the primary surface. They MUST remain visible whenever the terminal can reasonably fit them.

Routine actions MUST NOT require leaving the conversation for a separate dashboard.

### 2. One workspace, not many pages

The default interface is a stable workspace:

```text
┌ session / target / activity ─────────────────────────────────────┐
│ transcript                                           │ run tree │
│                                                      │          │
├ composer target ─────────────────────────────────────┴──────────┤
│ input                                                            │
├ model · thinking/mode · queue/attention · health ────────────────┤
```

Pickers, permission requests, authentication, help, and advanced details appear as temporary overlays or inline cards. Top-level tabs SHOULD be avoided unless a future feature is genuinely a separate work mode.

### 3. Progressive disclosure

The default view shows only information needed to decide what to do next:

- current session name;
- selected prompt target;
- response/tool activity;
- selected model or routing plan;
- thinking level or mode when meaningful;
- pending attention;
- runtime health.

Raw IDs, backend names, protocol messages, token accounting, full tool payloads, routing traces, and diagnostics are details. They MUST remain accessible but SHOULD be collapsed by default.

### 4. Preserve context

Opening a picker, authentication flow, permission request, help, or details view MUST preserve:

- the current draft;
- selected run;
- transcript scroll position;
- sidebar expansion;
- queued steer/follow-up messages.

Cancelling a temporary surface MUST return to the previous context without side effects.

### 5. Explicit targets

The user must always know which run will receive submitted input.

The composer MUST show a human-readable target label. Selection and active execution are separate concepts:

- **selected**: transcript and details currently inspected;
- **input target**: run that will receive the next prompt;
- **active**: run currently executing.

These states MUST use distinct indicators. A selected historical or non-interactive run MUST NOT silently become a valid input target. The composer instead remains targeted at the last actionable run or presents an explicit “Send to root” action.

### 6. Capability truthfulness

Controls MUST be driven by negotiated capabilities.

- Supported actions are shown normally.
- Temporarily unavailable actions are disabled with a concise reason.
- Unsupported routine actions SHOULD be omitted.
- Help and diagnostics MAY list unsupported capabilities explicitly.
- The frontend MUST NOT present a control that silently falls back to different behavior.

### 7. Attention, not noise

Only states requiring awareness or action should compete for attention:

- authentication required;
- permission or dialog awaiting response;
- execution failed or disconnected;
- a run waiting for user input;
- queued intervention;
- orderly shutdown in progress.

Normal streaming, refresh, persistence, and background projection updates MUST NOT generate repeated notifications.

### 8. Errors are actionable

An error message MUST answer:

1. What failed?
2. Which session or run was affected?
3. Was work preserved?
4. What can the user do now?

Raw transport or protocol text MAY appear in details, but not as the sole user-facing explanation.

### 9. Safe by default

Permission and secret prompts MUST make the consequence and scope visible. The default selection MUST be the least permissive practical choice.

Secrets MUST never appear in transcripts, command history, logs, notifications, or debug representations.

### 10. Stable geometry

Streaming content and status changes MUST NOT cause major panes to jump, resize, or reorder. Overlays MUST NOT steal persistent layout space.

## Core information architecture

### Header

The header MUST be compact. It shows, in priority order:

1. Phenix identity only when useful;
2. session name;
3. selected run breadcrumb when it differs from the root;
4. concise activity state.

Examples:

```text
Phenix  ·  Refactor router  ·  coordinator > verifier  ·  running
Phenix  ·  Refactor router  ·  waiting for permission
Phenix  ·  Refactor router  ·  offline, session preserved
```

The header SHOULD use display names. Raw session, tree, run, or backend IDs belong in details.

### Transcript

The transcript is a chronological projection for the selected run.

It MUST support distinct presentation for:

- user messages;
- assistant text;
- reasoning/thinking summaries when exposed by the backend;
- tool calls;
- terminal activity;
- permission requests;
- compaction markers;
- system and recovery notices;
- images or image placeholders;
- failures and cancellation.

Streaming updates MUST update the existing block rather than append near-duplicates.

The transcript SHOULD follow the end while the user has not scrolled away. Manual upward scrolling disables follow-end. Returning to the end re-enables it. New output while detached MUST show a non-intrusive “new output” indicator.

### Run sidebar

The sidebar is an orchestration navigator, not a second transcript.

Its default section is the current run tree. Each row shows:

- hierarchy;
- human-readable role or display name;
- state;
- attention indicator when needed.

Expanded details MAY show definition, model, objective, timestamps, failure code, or backend binding.

The sidebar MAY expose secondary sections for objectives, persisted sessions, and health, but these SHOULD not crowd the default run tree. Switching sections must not reset run selection.

The root run MUST always be reachable and visually distinguishable. Active, selected, failed, waiting, and completed states MUST remain distinguishable without relying on color alone.

### Composer

The composer includes:

- target label;
- multiline input;
- attachment indicator when images are present;
- concise submit/intervention hint when relevant.

It MUST retain a draft until the backend accepts ownership of the submitted request. If submission fails before acceptance, the draft MUST be restored.

Empty or whitespace-only submissions do nothing and do not enter history.

Input history SHOULD preserve exact multiline messages and avoid consecutive duplicates.

### Status line

The status line is a concise, single-line summary. It SHOULD contain only:

- model or virtual routing plan;
- thinking level or selected mode when relevant;
- queue/attention count;
- runtime health.

Examples:

```text
phenix/mixed · D2/high · ready
deepseek-v4-flash · low · 2 queued · running
mimo-v2.5 · permission required
offline · reconnecting · draft preserved
```

Arbitrary key/value diagnostics MUST NOT be dumped into the normal status line. They belong in details.

### Overlays

Searchable pickers and blocking prompts use a consistent overlay model:

- title;
- optional query/input field;
- list or prompt content;
- selected action;
- concise footer with relevant keys;
- `Escape` cancels or closes without changing unrelated state.

Only one blocking overlay is visible at a time. Additional dialogs are queued and represented by an attention count.

## Responsive behavior

### Wide terminals

At sufficient width, show transcript and sidebar side by side. The composer and status line span the primary workspace.

The sidebar SHOULD default to approximately one quarter to one third of available width and remain resizable.

### Medium terminals

The sidebar MAY collapse into a narrow rail or hidden pane. Opening it MUST not discard transcript position or composer content.

### Narrow terminals

The interface becomes a single primary surface:

1. header;
2. transcript;
3. composer;
4. status.

The run tree, details, and pickers open as overlays or temporarily replace the transcript. Closing them returns to the transcript at the same position.

No essential action may require a wide layout.

### Short terminals

The composer MUST retain at least one visible input row. Status text truncates before transcript or input becomes unusable. Overlays MUST scroll internally rather than overflow the terminal.

## Input and navigation contract

Default bindings are configurable, but the shipped configuration MUST provide a familiar baseline.

| Action | Default interaction |
|---|---|
| Submit prompt | `Enter` |
| Insert newline | `Shift+Enter` |
| Steer active run | `Ctrl+Enter` |
| Queue follow-up | `Alt+Enter` |
| Close overlay | `Escape` |
| Interrupt selected active run | `Escape` when no dismissible surface is open, or `Ctrl+C` |
| Next/previous focus | `Tab` / `Shift+Tab` |
| Input history | `Up` / `Down` from the composer |
| Navigate a list | arrows and `j` / `k` |
| Accept selected item | `Enter` |
| Open model picker | configurable global shortcut and `/model` |
| Open session picker | configurable global shortcut and `/resume` |
| Open authentication | configurable global shortcut and `/login` |
| Toggle details | configurable global shortcut |
| Orderly quit | `Ctrl+D` with a discoverable alias permitted |

Interaction rules:

- An overlay receives input before its underlying pane.
- `Escape` closes the active overlay before it can interrupt a run.
- Printable input not claimed by a focused pane mapping SHOULD route to the composer.
- Mouse selection, scrolling, pane resizing, and activation MUST mirror keyboard behavior.
- Key repeat MUST not submit, approve, cancel, or quit more than once per physical action.
- Pasted multiline text is inserted as text and MUST NOT submit automatically.
- Configured keymaps MAY replace defaults, but help must display the effective mappings.

## Slash command contract

Slash commands are a discoverability and efficiency layer, not a separate interaction model.

Typing `/` at the start of an otherwise empty composer SHOULD open command completion. Completion shows:

- command name;
- concise description;
- argument hint;
- capability or availability state.

Built-in and backend-provided commands share one searchable palette. Name collisions MUST be resolved deterministically and visibly; a command MUST NOT silently invoke a different implementation.

Required familiar commands include, where supported:

```text
/login
/logout
/model
/thinking
/mode
/new
/resume
/sessions
/compact
/abort
/reload
/help
/quit
```

Unknown commands are sent only through the typed backend command interface. If a backend rejects a command, the original text and a useful error remain visible.

## Usage specifications

Each scenario is independently testable. “Visible” means represented in text or shape as well as color.

### UX-001 — Normal launch

**Given** the configured backend can initialize  
**When** the user starts `phenix`  
**Then** the frontend:

1. opens the stable chat workspace immediately;
2. shows a concise starting state;
3. preserves input focus;
4. replaces starting with ready after initialization;
5. displays the active/new session and root run;
6. produces no success toast for routine initialization.

The terminal MUST be restored if initialization fails.

### UX-002 — Slow startup

**Given** initialization is still in progress  
**When** the user begins typing  
**Then** the draft remains editable.

Submitting while startup is incomplete either queues one request explicitly or explains that the runtime is still starting. It MUST NOT discard the draft.

A slow backend MAY expose elapsed time in details, not as an animated flood of status messages.

### UX-003 — Startup failure

**Given** the backend cannot start or negotiate a valid protocol  
**When** initialization fails  
**Then** the frontend shows:

- a plain-language failure summary;
- the configured backend/command in details;
- whether retry is possible;
- actions for retry, diagnostics, or exit.

It MUST NOT leave a blank alternate screen or only print a Rust debug value.

### UX-004 — First use without authentication

**Given** no usable provider credentials exist  
**When** the user opens Phenix  
**Then** the normal workspace remains visible with a single authentication-required callout.

The user MAY type a draft before authenticating. Submitting preserves that draft and opens the relevant authentication flow.

### UX-005 — Open authentication

**When** the user invokes login  
**Then** a searchable provider picker shows:

- provider display name;
- configured/not configured state;
- available methods;
- source in details.

Configured providers offer account/status or logout actions. Unconfigured providers offer supported login methods.

### UX-006 — API-key or secret login

**Given** a provider requests a secret  
**When** the prompt opens  
**Then**:

- input is masked;
- paste works;
- the value never enters generic input history;
- cancellation affects only that authentication flow;
- submission clears the visible buffer immediately;
- success or failure identifies the provider.

The UI MUST NOT provide a “show secret” action unless the backend explicitly requires confirmation and the terminal environment can do so safely.

### UX-007 — OAuth, device-code, or browser login

The prompt MUST state the next step and keep the frontend responsive.

A device code is copyable. A browser URL is openable where supported and also displayed in a copyable form. Waiting state includes cancel.

The frontend MUST accept late success/failure events after returning to the transcript and surface them once.

### UX-008 — Terminal-based login

**Given** authentication requires an interactive external command  
**When** the flow starts  
**Then** the frontend:

1. suspends terminal raw/alternate-screen state safely;
2. runs the exact typed external command;
3. waits for completion without rendering over it;
4. restores the frontend;
5. reports the authentication outcome;
6. retains the draft, selection, and scroll state.

Cancelling the external command MUST NOT cancel the whole session tree.

### UX-009 — Submit a normal prompt

**Given** an actionable run is targeted  
**When** the user submits non-empty input  
**Then**:

- the user message appears once in the transcript;
- the composer clears only after request ownership is accepted;
- the message enters input history once;
- the target run is explicit;
- activity changes to queued/starting/running as appropriate.

If acceptance fails, the exact draft is restored and the failure is shown.

### UX-010 — Multiline composition

`Shift+Enter` inserts a newline. Pasting multiline content preserves newlines and does not submit. Cursor movement and deletion remain Unicode-safe.

When the composer exceeds its visible height, it scrolls internally up to a reasonable maximum before growing or reducing transcript space.

### UX-011 — Prompt to a child run

Selecting an actionable child run updates the transcript and composer target. Submitting sends to that child only.

The frontend MUST NOT confuse the selected child with the root or silently redirect input. If the child cannot accept input, the composer explains this and keeps the last actionable target.

### UX-012 — Streaming response

While a response streams:

- one assistant block updates in place;
- the activity state is visible;
- the UI remains responsive;
- transcript follow-end behaves predictably;
- no token-level event appears as a notification;
- selecting another run does not stop the stream.

Completion changes the run state without inserting a redundant “completed” message unless that message conveys useful outcome information.

### UX-013 — Scroll away during streaming

Manual upward scrolling disables follow-end. New content does not force the viewport downward.

A compact “new output” marker appears. Activating it returns to the end and re-enables follow-end.

### UX-014 — Interrupt execution

With no dismissible overlay open, interrupt sends cancellation to the selected active run or clearly identified active target.

The first interrupt is graceful. The UI immediately shows “cancelling” and prevents duplicate requests. The final state distinguishes cancelled from failed.

Interrupting one child MUST NOT implicitly terminate unrelated runs or the entire tree. A separate tree-level stop action requires explicit scope.

### UX-015 — Steering an active run

When steering is supported and a run is active, `Ctrl+Enter` submits the composer as steering input.

The message appears as a queued/intervention item associated with the target run. Queue status is visible. The UI distinguishes:

- accepted and pending;
- applied;
- rejected because the run completed;
- cancelled.

If steering is unsupported, the action is unavailable with a reason and the text remains in the composer.

### UX-016 — Queue a follow-up

When follow-ups are supported, `Alt+Enter` queues a message to execute after the current turn.

Queued follow-ups are inspectable and removable before execution. The transcript or status shows the count without duplicating the full text.

A follow-up MUST NOT be confused with immediate steering.

### UX-017 — Queue race

If a run completes while steering or follow-up submission is in flight, the frontend shows the backend’s actual disposition and preserves text when it was not accepted.

It MUST NOT claim a message was queued based solely on local intent.

### UX-018 — Tool starts

A tool call appears inline at the point it occurs, with:

- human-readable tool name;
- concise input summary;
- running state;
- owning run.

Routine tool cards are compact by default. Selecting or expanding reveals structured input, exact command/path, timestamps, and streaming output when available.

### UX-019 — Tool updates and completion

Updates modify the existing tool card. Completion visibly distinguishes success, failure, and abort.

Long output is bounded and scrollable. The final summary remains visible when collapsed. Tool output MUST NOT make the whole transcript unusable.

### UX-020 — Terminal activity

Terminal-backed tools use a terminal-style card with command, working directory, state, and bounded output.

The default card shows recent relevant output. The user can expand it into an overlay or dedicated temporary pane without losing conversation context.

ANSI control data MUST NOT corrupt surrounding UI. Exit code and signal are visible in details.

### UX-021 — Permission request

A permission request is an attention event associated with its exact run and tool.

It shows:

- requested action;
- command, paths, host, or resource as applicable;
- working directory and scope;
- why approval is needed when supplied;
- backend-provided choices.

The default selection is the least permissive practical option. Common choices may include deny, allow once, or allow for an explicit scope. The frontend MUST display the actual options received rather than invent unsupported policy.

A permission waiting in an unselected child is surfaced globally and selecting the alert takes the user to that run.

### UX-022 — Respond to permission

Approving or denying updates the same inline request card and returns focus to the previous surface.

Key repeat cannot submit multiple responses. Once answered, the prompt becomes immutable and shows the selected decision.

Denying a permission is a normal outcome, not a runtime failure.

### UX-023 — Multiple attention requests

Only one blocking prompt is presented at a time. Additional permission, authentication, or extension requests queue in arrival order unless priority rules are explicitly defined.

The status line shows the count. Cancelling one request MUST NOT discard the rest.

### UX-024 — Extension selection, confirmation, and text input

Extension dialogs use the same overlay language as native pickers.

The prompt identifies the requesting extension and owning run. Secret input receives secret handling. Editor requests may suspend to the configured editor and return safely.

An extension cannot spoof global runtime failure or authentication chrome; its origin remains visible.

### UX-025 — Select a model

The model picker is searchable and grouped by provider or virtual routing family.

Each entry shows:

- display name;
- provider/model identifier in details;
- selected state;
- image/thinking support where relevant;
- unavailable reason when known.

Selecting a model applies to the explicit run/tree scope shown by the picker. The status line updates only after backend confirmation.

### UX-026 — Select a virtual/routed model

Virtual models such as `phenix/free` or `phenix/mixed` are presented as first-class model choices.

The normal status line shows the virtual model or routing plan. The concrete provider/model chosen for an individual turn appears in transcript/run details, not as a confusing replacement for the configured virtual model.

### UX-027 — Select thinking level

Thinking choices are shown only when supported by the selected model or routing plan.

The picker uses display labels and a short cost/latency implication where known. Unsupported levels are not selectable. The confirmed level appears near the model in the status line.

A backend correction or downgrade must be shown; the UI must not continue displaying an unaccepted value.

### UX-028 — Select agent/session mode

Modes such as plan, build, review, or backend-specific alternatives use a searchable picker with descriptions.

The currently selected mode is visible. Mode changes state their scope and are recorded as transcript/session events where supported.

Mode and thinking level remain separate concepts.

### UX-029 — Attach an image

When image prompting is supported, the composer can attach one or more images through paste, file selection, drag/drop where available, or a command.

Before submission, each attachment has a compact name/type/size representation and remove action. Submission shows an image placeholder or terminal-native preview where supported.

Unsupported media, excessive size, or model incompatibility is reported before losing the draft.

### UX-030 — Backend does not support images

Image controls are hidden or disabled with an explanation. Pasting binary image data MUST NOT insert terminal garbage or silently discard it.

Changing to a compatible model MAY be offered, but never performed without confirmation.

### UX-031 — Open the session picker

The session picker is searchable and sorted primarily by recent activity, with project/current-directory relevance as a secondary cue.

Each entry shows:

- user-facing name;
- last update;
- working directory/project;
- concise state or last outcome.

Raw IDs and file paths are details. The current session is marked.

### UX-032 — Create a session

Creating a session opens or activates a clean conversation using the configured immutable tree definition.

The UI MUST distinguish:

- a new persisted conversation;
- a new child/delegated run within the current tree;
- a new independently configured tree.

Routine “new session” should not ask architectural questions. Advanced tree configuration is selected before creation through a preset or explicit command.

### UX-033 — Resume/switch a session

Switching sessions preserves the current session before changing the workspace.

The transcript, run tree, objectives, model/mode state, and actionable target are restored from backend truth. A loading state is scoped to the content being replaced; the entire terminal need not blank.

Failure leaves the current session intact and selected.

### UX-034 — Rename a session

Rename is available from session actions or a command. The current name is prefilled. Empty names revert to backend/default naming only after explicit confirmation.

Renaming changes display metadata, not identity or session content.

### UX-035 — Fork from history

When branching is supported, the user can select a transcript/session entry and create a fork.

The confirmation states:

- source session;
- branch point;
- whether workspace files are affected;
- resulting session/tree scope.

The original remains unchanged. The new session opens only after backend confirmation.

### UX-036 — Clone a session

Cloning duplicates the supported session context at the current leaf without implying a historical branch point. The UI explains this distinction where both clone and fork exist.

### UX-037 — Export a session

Export offers a sensible default path and shows what is included: transcript, run tree, objectives, tool summaries, logs, and metadata according to backend capability.

Completion provides the exact path and a copy/open action. Failure states whether any partial output exists.

Secrets and redacted values MUST remain excluded.

### UX-038 — Navigate the run tree

Keyboard arrows or `j`/`k` move selection. Left/right or familiar expand/collapse keys control hierarchy. Mouse clicks perform the same selection.

Selection never resets to the root merely because a snapshot refreshes. Stable run IDs preserve selection and expansion.

The viewport scrolls to keep the selected row visible.

### UX-039 — Inspect a delegated run

Selecting a child shows its own transcript while retaining enough breadcrumb context to understand its parent and objective.

The sidebar shows which runs are active even when not selected. The header indicates the selected path. Returning to root is one obvious action.

### UX-040 — Run lifecycle states

The frontend has consistent labels and markers for:

- created;
- starting;
- running;
- waiting;
- completing;
- completed;
- failed;
- cancelled;
- orphaned.

“Waiting” must identify what it waits for when known: user, permission, child, retry, backend, or external command.

“Orphaned” is treated as recoverable/diagnostic state, not a synonym for completed.

### UX-041 — Objectives and workflows

Objectives are user-visible outcomes, not every internal delegation step.

The objectives view shows hierarchy, state, and the runs contributing to each objective. Selecting an objective MAY filter or reveal related runs, but does not replace the transcript as the primary surface.

Workflow stages and routing details are collapsed by default and available in details.

### UX-042 — Parallel runs

When several runs execute concurrently:

- all active runs have persistent markers;
- the selected transcript remains stable;
- global attention is aggregated;
- background output does not steal focus;
- completion notices are concise and deduplicated.

The user can identify which model/role owns each active run in details.

### UX-043 — Compaction

When compaction is available, `/compact` optionally accepts instructions and clearly targets one run/session context.

The UI shows compaction as a lifecycle operation, not an assistant message. It indicates progress, completion, cancellation, and failure. The resulting transcript includes a compact marker and preserves access to pre-compaction history where the backend supports it.

### UX-044 — Automatic compaction

Automatic compaction SHOULD be non-blocking unless user action is required. It produces at most one concise notice and a durable transcript marker.

The user must be told if compaction changes recoverability or removes local history.

### UX-045 — Retry

Retry behavior is represented separately from model generation.

When automatic retry is active, the UI shows attempt count, reason, and next action in details while keeping the primary status concise. The user can abort retry without losing the session.

A retry MUST NOT duplicate a user message in the transcript.

### UX-046 — Run failure

A failed run card or transcript notice shows:

- failed operation;
- concise cause;
- retryable/non-retryable state;
- preserved work;
- relevant actions such as retry, inspect, change model, authenticate, or return to parent.

A child failure must propagate meaningful status to its parent/objective without necessarily failing the entire tree.

### UX-047 — Degraded connection

A transport failure changes health to degraded and preserves all local UI state.

The frontend distinguishes:

- backend still usable with reduced capability;
- reconnecting;
- disconnected but session persisted;
- fatal stop.

Repeated identical errors are coalesced. Recovery returns to ready without clearing the transcript or draft.

### UX-048 — Backend crash

If the backend process exits unexpectedly:

- terminal control remains usable;
- the session’s known persistence state is shown;
- restart/reconnect is offered when supported;
- diagnostics include exit status and recent relevant logs;
- quit remains available.

The frontend MUST NOT report a successful orderly shutdown.

### UX-049 — Crash recovery on next launch

If an unclean previous session is recoverable, Phenix offers:

- recover the most relevant session;
- open a session picker;
- start new.

It does not silently merge a recovered transcript into a new session. Recovery preserves the complete root/child relationship where available.

### UX-050 — Resource/config reload

Reload is explicit. Success is quiet or shown once. Failure keeps the last valid configuration/resources active and identifies the invalid source.

A frontend keymap/theme/layout reload MUST preserve session state and restore focus. An invalid custom layout MUST NOT make the interface unusable.

### UX-051 — Help and discovery

Help displays effective bindings from the active configuration, grouped by context. It also lists core slash commands and indicates capability-dependent actions.

Help MUST be reachable without knowing a custom keybinding, for example through `/help` and the command palette.

The default empty-state transcript SHOULD include no more than a few high-value hints.

### UX-052 — Details mode

Details mode adds diagnostic information in place without restructuring the workspace.

It MAY reveal IDs, definitions, exact states, model routing, timestamps, queue contents, health diagnostics, or tool payloads. Toggling details preserves selection and scroll.

Details are copyable and never the only location for actionable failures.

### UX-053 — Copy and selection

Terminal text intended for inspection SHOULD be selectable using normal terminal mechanisms when mouse mode permits, or through explicit copy actions.

The user can copy at least:

- assistant/user message;
- code block;
- tool command/output;
- device code/URL;
- error detail;
- session/run identifier in details.

Copy actions provide a concise confirmation and never alter focus unexpectedly.

### UX-054 — Notifications

Success notifications are brief and expire or yield to newer information. Errors and requests requiring action remain accessible until acknowledged or resolved.

Notifications are deduplicated by semantic event, not raw text alone. A notification history MAY exist in details.

### UX-055 — Orderly quit

Quit initiates backend/session shutdown and shows “stopping” without immediately dropping the terminal.

The frontend exits after persistence/cleanup confirmation or a clearly bounded fatal shutdown path. A second quit request MAY offer force quit, but must state that in-flight persistence could be lost.

Terminal state is restored in all exit paths.

### UX-056 — Resize and focus changes

Resizing recalculates layout without losing state or panicking at zero/small dimensions. Focus loss/gain does not submit or cancel anything.

If the terminal becomes too small, Phenix shows a minimal usable message and restores the workspace automatically when space returns.

### UX-057 — Multiple independently configured trees

When the host runs multiple session trees, each is presented as an independent workspace/session scope with immutable configuration.

Switching trees never suggests that models, tools, workflows, permissions, or routing were mutated in the existing tree. Creating a differently configured tree is an explicit “new workspace/tree” action in advanced UI.

### UX-058 — Unsupported capability

Invoking an action that became unsupported after negotiation produces one precise message and preserves user input.

The frontend MUST NOT convert, for example, steer into a follow-up, fork into clone, or built-in tool policy into silent allow-all behavior.

### UX-059 — Stale/out-of-order events

Late events for a previously selected run update that run without stealing selection. Stale snapshots MUST NOT regress newer run state, transcript content, queue state, or answered prompts.

Duplicate events do not create duplicate transcript blocks or attention requests.

### UX-060 — Accessibility and non-color terminals

Every important state uses text, symbols, or structure in addition to color.

The default theme must remain legible with limited color support. Focus, selection, active execution, failure, waiting, and disabled controls remain distinguishable in monochrome.

## Permission and attention hierarchy

Attention priority from highest to lowest:

1. fatal runtime failure;
2. secret/authentication prompt requiring immediate response;
3. permission or extension request blocking active work;
4. failed run;
5. disconnected/degraded state;
6. queued steering/follow-up;
7. successful background completion;
8. routine informational status.

Higher-priority attention MAY temporarily replace lower-priority status text but MUST NOT discard it.

An attention item always records its origin: tree, session, run, provider, or extension as applicable.

## State language

Use short, consistent user-facing labels:

| Internal concept | Preferred label |
|---|---|
| Backend health starting | Starting |
| Backend health ready | Ready |
| Backend health degraded | Degraded or Reconnecting |
| Backend health failed | Runtime failed |
| Run created | Queued |
| Run starting | Starting |
| Run running | Running |
| Run waiting | Waiting for … |
| Run completing | Finishing |
| Run completed | Completed |
| Run failed | Failed |
| Run cancelled | Cancelled |
| Run orphaned | Detached |
| Streaming steer | Steer |
| Streaming follow-up | Follow-up |
| Session tree | Workspace or session tree in details |
| Backend binding | Backend in details |
| ACP session ID | Session ID in details |

Protocol and type names MAY appear in diagnostics, not primary labels.

## Empty states

Empty states explain the next useful action without filling the screen.

### No session/run yet

```text
Start by describing what you want Phenix to do.
Enter sends · Shift+Enter adds a line · /help shows commands
```

### No transcript for selected run

```text
No messages in this run yet.
```

### No models/providers/sessions

The picker states whether none are configured, none are supported, loading failed, or the list is genuinely empty. “No entries available” alone is insufficient when a recovery action exists.

## Search, filtering, and large histories

Pickers filter incrementally without changing selection unpredictably.

Large transcripts and run trees MUST be virtualized or otherwise bounded so updates remain responsive. Search MAY be added as a transcript overlay, but it must preserve follow-end state and return to the prior location when closed.

Session search SHOULD match name, working directory, project, model, and ID, with names and recent sessions ranked first.

## Data preservation rules

The frontend MUST preserve:

- composer drafts across overlays, focus changes, resize, authentication, and recoverable backend failures;
- accepted prompt history across session refreshes;
- stable selection by typed ID;
- transcript blocks by stable block ID;
- queued interventions until backend disposition;
- answered prompt decisions as immutable transcript state;
- last valid configuration when reload fails.

The frontend MUST NOT persist secrets, temporary secret buffers, or terminal control sequences as generic text.

## Security and trust cues

- External commands display executable and arguments in details before launch when user action is required.
- Permission prompts identify the exact requester and scope.
- Browser/device authentication identifies the provider.
- Extension dialogs identify the extension.
- Auto-approval or trusted-workspace modes, when supported, are visible in status/details and never implied.
- Destructive or externally visible operations SHOULD require an explicit backend permission choice unless immutable policy already authorizes them.
- The UI must not label a policy decision as “safe” unless that classification came from an authoritative policy component.

## Performance and responsiveness

Under normal load:

- keypresses and local navigation should render without waiting for backend round trips;
- streaming updates may be batched but semantic events are not dropped;
- refresh/clock events may be coalesced;
- selecting a run should display cached transcript state immediately;
- expensive details load asynchronously and reject stale results;
- a busy child run cannot freeze the root composer;
- overlay interaction remains responsive while transcripts stream.

No fixed session timeout is implied by frontend activity indicators.

## Adapter consistency

The Ratatui frontend and future Neovim adapter MUST implement the same semantic behavior:

- same action meanings;
- same selected/input-target/active distinction;
- same capability gating;
- same overlay/dialog lifecycle;
- same persistence and error rules;
- same configured keymap descriptions.

Renderer-specific presentation MAY differ. Backend behavior and usage semantics may not.

## Acceptance-test structure

Every implemented usage scenario should map to at least one of:

- **Reducer test** — pure state transition and emitted effect;
- **Projection test** — backend event/reply to stable view state;
- **Recording renderer test** — visible content, order, focus, and responsive layout;
- **Fake ACP integration** — request/reply/event lifecycle and capability negotiation;
- **Packaged end-to-end test** — terminal frontend through gateway to credential-free fixture.

### Required P0 acceptance set

The frontend is not viable for ordinary use until automated coverage exists for:

- UX-001 normal launch;
- UX-003 startup failure and terminal restoration;
- UX-004 through UX-008 authentication;
- UX-009 through UX-014 prompt, streaming, and interruption;
- UX-018 through UX-023 tools, terminal, permissions, and attention;
- UX-025 through UX-028 model, thinking, and mode selection;
- UX-031 through UX-033 session creation and resume;
- UX-038 through UX-040 run-tree navigation and lifecycle;
- UX-046 through UX-049 failure and recovery;
- UX-055 orderly quit;
- UX-056 resize safety;
- UX-058 unsupported capabilities;
- UX-059 stale/duplicate event handling.

### P1 acceptance set

The next complete-product tier covers:

- steering and follow-ups;
- image attachment;
- rename, fork, clone, and export;
- objectives and parallel runs;
- compaction and retry;
- details, copy, effective help, and configuration reload;
- narrow-terminal behavior;
- multiple independent trees.

## Implementation gap checklist

This checklist records frontend work implied by the usage contract. It is not a second product model.

- [ ] Separate selected run, input target, and active run visually and in state.
- [ ] Restore failed/unaccepted submissions to the composer.
- [ ] Add command completion/palette entry point and effective help.
- [ ] Add a dedicated thinking-level picker rather than notification-only output.
- [ ] Add session mode picker with descriptions.
- [ ] Add permission-request domain state and inline/overlay response UI.
- [ ] Render terminal events as bounded terminal cards.
- [ ] Add image attachment state and submission UI.
- [ ] Add queue inspection/removal for steering and follow-ups.
- [ ] Add session rename, fork, clone, tree inspection, and export actions.
- [ ] Add retry and compaction lifecycle projections.
- [ ] Preserve sidebar expansion/selection and transcript scroll by stable ID.
- [ ] Add new-output indication when follow-end is disabled.
- [ ] Replace raw status key/value dumping with prioritized product status.
- [ ] Add actionable degraded/fatal recovery surfaces.
- [ ] Add responsive narrow/short-terminal layouts.
- [ ] Add copy actions and bounded long-output handling.
- [ ] Ensure capability-gated controls never silently fall back.
- [ ] Add fake-ACP and recording-renderer scenarios for the P0 set.

## Review rules

A frontend change should be rejected when it:

- adds a routine task that requires navigating away from the conversation;
- exposes backend/protocol IDs in the default view;
- creates a new action without defining target and scope;
- introduces a modal that can lose the draft or transcript position;
- treats selected, active, and input-target runs as the same state;
- displays unsupported actions as if they work;
- turns normal background events into notification spam;
- reports raw errors without preservation/recovery information;
- requires color to understand state;
- makes a backend-specific behavior part of the frontend contract;
- adds a second incompatible interaction path instead of extending the semantic action model.

## Comparative references

These references informed only the familiarity baseline; this document remains the Phenix product contract.

- Anthropic Claude Code CLI reference: interactive sessions, resume, model and permission modes, slash commands.
- Gemini CLI command and session-management documentation: slash commands, session browser, permissions, checkpoints, and history.
- OpenCode TUI/CLI and permission documentation: terminal workspace, model/session pickers, command palette, and scoped approvals.
