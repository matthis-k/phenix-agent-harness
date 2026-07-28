# Stock Pi sessions

`session.stock` is a first-class Phenix catalog entry for running an ordinary Pi session when no predefined workflow or specialized Phenix agent fits a bounded task well enough.

The stock session is selectable by predefined and dynamic workflows. It is supervised by Phenix for run identity, cancellation, persistence, recovery, budgets, diagnostics, and typed completion, but it does not receive a Phenix role prompt, workflow API, delegation instructions, or a specialized tool policy.

## Catalog contract

```text
session.stock — Stock Pi session
kind: session
input: request.stock-session
output: dynamic
```

The catalog output is marked `dynamic` because every workflow invocation must bind one concrete registered output schema.

## Workflow policy

Verification is not intrinsic to a stock session. The owning workflow decides whether to:

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
  "definitionId": "session.stock",
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
run: session.stock
input: stock-task.input
wait: await
input-schema: request.stock-session
output-schema: outcome.scout-report
```
````

For ordinary definitions, `output-schema` must match the definition's fixed public output. For `session.stock`, it must be a concrete schema and may not use the stock handoff envelope itself.

## Runtime handoff

Before starting the child, the workflow runtime adds:

- `outputSchema`: the concrete schema ID;
- `outputContract`: that schema's JSON contract.

The stock session receives Pi's ordinary resources and built-in tools, plus only two Phenix run-scoped tools:

- `phenix_return`, accepting `{ outputSchema, value }`;
- `phenix_fail`, accepting a bounded structured failure.

The root Phenix extension remains disabled inside the child to prevent recursive orchestration sessions. `phenix_progress` and workflow/delegation tools are not exposed.

When the child returns, the workflow runtime verifies the schema ID, validates `value` against the registered concrete schema, unwraps the value, and only then advances the workflow. Invalid handoffs fail the workflow with `output_invalid` and preserve the stock child as the cause run.

## Selection trade-off

A stock session is deliberately less behaviorally controlled than a Phenix workflow or specialized agent. The composer should prefer, in order:

1. one complete predefined workflow;
2. a composition of predefined workflows;
3. specialized Phenix agents;
4. `session.stock` for a genuinely uncovered bounded task.

This is a selection preference, not an authorization distinction. Once a workflow selects `session.stock`, its ordinary Pi capabilities are intentional and its output remains subject to the workflow's typed boundary and any verification nodes chosen by that workflow.
