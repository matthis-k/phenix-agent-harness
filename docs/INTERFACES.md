# Phenix execution interfaces

Phenix uses one revisioned execution authority as the source of truth for managed work.

## Authority

The authority owns objective, node, handle, acceptance, capability, revision, and event state. Workflow, task, handle, and TUI views are projections. Pi sessions are replaceable execution transcripts and never own workflow truth.

Every mutation is idempotent and may include an expected objective revision. Stale revisions fail rather than overwriting newer state.

## Root-session execution journal

Every root Pi session owns one append-only JSONL journal for its complete execution tree:

```text
.phenix-agent-state/sessions/<root-session-id>-<digest>/events.jsonl
```

The root runtime is the sole writer. SDK children and RPC workers report observations to the root; they never append to the file directly. The writer assigns one monotonic sequence across the root, children, grandchildren, workflow authority, tools, routing, parent-child messages, lifecycle transitions, settlement, and recovery.

The journal is the canonical chronological record of what happened in that root-session tree. The revisioned execution authority remains the canonical validator and mutator of workflow state: child observations are recorded as claims or runtime events, while only authority-committed events establish objective, node, handle, capability, or acceptance transitions.

Each entry carries root-session, emitting session, actor, and optional parent-session, objective, node, handle, and child-run identities. Nested sessions therefore retain their real ancestry instead of being flattened under the root. `/phenix journal` reports the active journal path.

Payloads are bounded before persistence. Authentication values and secrets are redacted, reasoning content is represented by length and digest, and oversized values are replaced with a digest and bounded preview. Large binary or repository artifacts remain external and should be referenced rather than copied into JSONL.

## Processes

- **Interactive host:** user interaction and Pi presentation.
- **Execution authority:** the single writer for objective and acceptance state.
- **Session journal writer:** the single serialized writer for root and descendant execution history.
- **Runtime supervisor:** starts, steers, awaits, aborts, and disposes Pi sessions.
- **Child agent:** performs one capability-bounded assignment and submits a typed result.
- **Evidence runner:** executes deterministic checks.
- **Semantic verifier:** independently approves, rejects, or reports an inconclusive result.
- **Presentation observer:** renders authority projections only.
- **Model router:** resolves abstract role and assurance needs to concrete models.

These are logical boundaries and may share an operating-system process.

## Lifecycle

Runtime settlement and acceptance are separate:

1. A node becomes ready and receives a durable handle.
2. The runtime starts and eventually settles, fails, cancels, or becomes orphaned.
3. A structured result is submitted.
4. Contract and workflow completion are checked.
5. Deterministic evidence and semantic verification run according to assurance.
6. The authority accepts, rejects, permits repair, or escalates.

A child process exiting without a valid result is not success.

## Assurance

- **A0 Direct:** low-impact direct work.
- **A1 Contracted:** structured assignment and schema-validated result.
- **A2 Verified:** deterministic evidence and independent review where needed.
- **A3 High assurance:** isolation, semantic verification, critic review, and stronger repair policy.

Assurance is independent from reasoning difficulty. Security, authentication, secrets, CI, deployment, production, release, broad mutation, and requested QA raise assurance even for short tasks.

## Delegation

Preset workflows remain available. The general workflow also exposes bounded ad-hoc base, planner, architect, implementer, tester, critic, and finalizer actions. These actions retain typed contracts, execution limits, depth limits, capability scoping, and acceptance policy; they do not bypass workflow authority.

## Runtime adapters

The supervisor selects from one transport-neutral backend interface:

- **Pi SDK** is the deterministic fallback and handles nested orchestration.
- **Pi RPC** is selected for high-assurance leaf assignments or by an explicit `PHENIX_CHILD_BACKEND=rpc` override.
- RPC refuses assignments that retain child-delegation authority.
- `PHENIX_CHILD_BACKEND=sdk` forces the in-process runtime.
- RPC workers load only their explicit completion contract, task capability, declared integrations, skills, and tool allowlist.
- RPC framing is strict LF-delimited JSON with correlated commands and resumable asynchronous events.
- A cycle settles only on Pi's fully settled event, not merely on an agent-end event.
- One adapter-independent wall-clock cancellation boundary covers startup, streaming, idle hangs, repair cycles, and disposal.

Adapter choice never changes workflow, task, contract, handle, or acceptance semantics.

## Events and recovery

Authority events are ordered and cursor-readable. They are also projected into the root-session journal with the resulting objective, node, handle, and active-handle state so failures can be correlated with child and tool activity in one sequence.

Handles remain meaningful after parent-turn completion, UI disconnection, Pi session replacement, and authority restart. Active-child status is derived from durable non-terminal handles scoped to the current root session, with the process-local manager used only before an objective is initialized.
