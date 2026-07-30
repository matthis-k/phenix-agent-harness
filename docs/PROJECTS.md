# Cross-session projects

A Phenix project coordinates work whose destination is too large or too uncertain for one Pi session. It is not a larger run tree. It is a durable project aggregate that independent root sessions and child runs can inspect and advance.

## Canonical state

Each project has an append-only JSONL ledger under `.phenix-agent-state/projects/<project-id>/events.jsonl`. The ledger is canonical. GitHub issues are a synchronized human-facing projection and may be reconstructed from the ledger.

A project records:

- the named destination, use case, completion criteria, and non-goals;
- a decision graph with native dependency edges;
- unresolved fog that is in scope but not yet precise enough to ticket;
- claims tying one decision to one Phenix run and Pi session;
- resolutions with answer, rationale, evidence, consequences, and run provenance;
- durable intervention requests and operator answers.

## Charting protocol

Charting is a root-supervisor conversation and does not dispatch repository execution.

1. Pin the destination: the resulting artifact or state, its concrete use case, observable completion criteria, and explicit non-goals.
2. Explore breadth-first. Identify questions whose answers materially constrain the route.
3. Create a decision only when its question is precise. Keep suspected but unformulated work in project fog.
4. Classify each decision as `research`, `prototype`, `grilling`, or `task`, and as `afk` or `hitl`.
5. Add dependency edges after the decisions have stable IDs.
6. Stop charting before implementing the destination. A project is ready when its current frontier is explicit.

Decision tickets answer questions. They are not implementation slices by default. A `task` may perform work only when that work is a prerequisite for a later decision.

## Working a decision

A session loads the project at low resolution, selects an open unblocked decision, and claims it before work. The actionable frontier contains open, unclaimed decisions whose dependencies are all resolved. Claimed and user-blocked decisions remain visible as active work, but another session cannot claim them.

A decision resolution is canonical only when it records:

- the concise answer;
- why that answer was selected;
- evidence or linked artifacts;
- consequences for later decisions or implementation;
- the resolving run and timestamp.

One session should resolve one decision. Independent frontier decisions may be claimed by separate sessions concurrently.

## User intervention

A claimed child calls `phenix_project` with `action=request_input` when it needs operator judgment or action. Phenix persists the request, focuses the root UI, and identifies it with an intervention ID. The root answers with `action=answer_input` and that ID.

The delivery contains only the request and answer. It does not copy the root conversation into the child. If the child is no longer live, the answer remains durable in the project ledger for a later session.

## GitHub projection

`action=publish` uses the authenticated `gh` CLI to create:

- one `phenix:project-map` issue;
- one native sub-issue per decision;
- native `blocked by` relationships for decision dependencies;
- type and interaction labels;
- issue assignment when a decision is claimed;
- a canonical resolution comment and closure when a decision resolves.

The map issue is an index. It summarizes resolved decisions and links to the issue that owns each full resolution. Open decisions remain visible as sub-issues and through GitHub's dependency graph.

## Compiling the specification

`action=export_spec` deterministically renders the current destination, resolved decisions, provenance, frontier, fog, and out-of-scope decisions as Markdown. It does not ask another model to reconstruct why decisions were made.
