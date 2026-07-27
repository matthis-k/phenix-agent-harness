# Stock Pi sessions

`session.stock` runs an ordinary Pi session for a bounded task that does not fit a predefined workflow or specialized Phenix agent.

It remains supervised for run identity, cancellation, persistence, recovery, budgets, diagnostics, and typed completion. It does not receive a Phenix role prompt, delegation tools, or workflow instructions.

## Catalog entry

```text
session.stock — Stock Pi session
kind: session
input: request.stock-session.v1
output: dynamic
```

Each invocation must select one concrete registered output schema.

## Workflow use

The owning workflow may return the result directly, verify it, combine it with other results, or retry it through declared transitions. Phenix does not add a verifier automatically.

Dynamic graph example:

```json
{
  "kind": "invoke",
  "id": "investigate",
  "definitionId": "session.stock",
  "outputSchema": "outcome.scout-report.v1",
  "input": {
    "source": "object",
    "fields": {
      "task": { "source": "input", "path": ["objective"] },
      "context": { "source": "input", "path": ["context"] }
    }
  }
}
```

Markdown state example:

````markdown
### investigate

```phenix-state
kind: invoke
run: session.stock
input: stock-task.input
wait: await
input-schema: request.stock-session.v1
output-schema: outcome.scout-report.v1
```
````

For ordinary definitions, `output-schema` must match the fixed definition output. For `session.stock`, it names the concrete result expected from this invocation.

## Result handoff

The child receives the selected schema ID and JSON contract. Its Phenix tools are limited to:

- `phenix_return`, accepting `{ outputSchema, value }`;
- `phenix_fail`, accepting a bounded structured failure.

The returned schema ID and value are validated before the workflow advances. Invalid results fail with `output_invalid` and retain the stock child as the cause run.

Prefer predefined workflows and specialized agents when they fit. Use `session.stock` for genuinely uncovered bounded work.
