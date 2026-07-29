# Stock Pi agent

`agent.stock` is the first-class Phenix fallback for running an ordinary Pi agent when no predefined workflow, specialized Phenix agent, or useful specialist composition fits a bounded task well enough.

The stock agent is selectable directly by the dispatcher and from predefined or dynamic workflows. It is supervised by Phenix for run identity, cancellation, persistence, recovery, budgets, diagnostics, and typed completion, but it does not receive a Phenix role prompt, workflow API, delegation instructions, or a specialized tool policy.

`session-mode: stock` remains an internal execution marker. It tells the runtime to use Pi's ordinary session behavior; it is not part of the public definition namespace.

## Catalog contract

```text
agent.stock — Stock Pi agent
kind: agent
input: request.stock-session
output: dynamic
```

The catalog output is marked `dynamic` because every invocation must bind one concrete registered output schema.

## Dispatch policy

The root dispatcher prefers, in order:

1. one predefined workflow that covers the whole request;
2. the coordinator when a combination of specialized workflows or agents is useful;
3. `agent.stock` when neither a specialist nor a useful specialist composition suits the task.

For example:

```text
QA and fix
root → agent.dispatcher → agent.coordinator → workflow.qa + workflow.implement

Tell a short story
root → agent.dispatcher → agent.stock
```

A direct stock dispatch binds `outcome.base`. The complete user-facing answer belongs in `summary`; separate structured values may use `artifacts`, and genuine blockers use `unresolved`. The dispatcher unwraps and validates the stock handoff before returning it to the root.

## Workflow policy

Verification is not intrinsic to the stock agent. The owning workflow decides whether to:

- return the typed stock result directly;
- pass it to `agent.verifier` or `agent.critic`;
- combine it with other typed branches; or
- reject or retry it through ordinary workflow control flow.

Phenix does not automatically append a verifier.

## Dynamic workflow example

```json
{
  "kind": "invoke",
  "id": "investigate",
  "definitionId": "agent.stock",
  "outputSchema": "outcome.scout-report",
  "input": {
    "source": "object",
    "fields": {
      "task": { "source": "input", "path": ["objective"] },
      "context": { "source": "input", "path": ["context"] }
    }
  }
}
```

A verifier is represented as an explicit downstream invoke node. Omitting that node is valid.

## Markdown workflow example

````markdown
### investigate

```phenix-state
kind: invoke
run: agent.stock
input: stock-task.input
wait: await
input-schema: request.stock-session
output-schema: outcome.scout-report
```
````

For ordinary definitions, `output-schema` must match the definition's fixed public output. For `agent.stock`, it must be a concrete schema and may not use the stock handoff envelope itself.

## Runtime handoff

Before starting the child, the caller adds:

- `outputSchema`: the concrete schema ID;
- `outputContract`: that schema's JSON contract.

The stock agent receives Pi's ordinary resources and built-in tools, plus only two Phenix run-scoped tools:

- `phenix_return`, accepting `{ outputSchema, value }`;
- `phenix_fail`, accepting a bounded structured failure.

The root Phenix extension remains disabled inside the child to prevent recursive orchestration sessions. `phenix_progress` and workflow/delegation tools are not exposed.

When the child returns, the caller verifies the schema ID, validates `value` against the registered concrete schema, unwraps the value, and only then returns or advances. Invalid handoffs fail with `output_invalid` while preserving the stock child as the concrete run.

## Selection trade-off

The stock agent is deliberately less behaviorally controlled than a Phenix workflow or specialized agent. It is the fallback for genuinely uncovered bounded work, not a shortcut around an applicable specialist. Once selected, its ordinary Pi capabilities are intentional and its output remains subject to the typed boundary and any explicit verification chosen by an owning workflow.
