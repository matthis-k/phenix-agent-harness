# Declarative workflow tests

Workflow Markdown may contain an optional `## Tests` section. Tests are compiled separately from the production `WorkflowDefinition` and execute through the real `WorkflowProcessManager` with an in-memory ledger and scripted child outcomes.

## Format

Each `###` subsection is one scenario containing a JSON `phenix-test` fence:

````md
## Tests

### retry-then-succeed

```phenix-test
{
  "input": {
    "objective": "Implement the requested change"
  },
  "mocks": {
    "implement": [
      {
        "fail": {
          "code": "tool_unavailable",
          "message": "nix was not found in PATH",
          "retryable": true
        }
      },
      {
        "return": {
          "summary": "Implemented after retry",
          "changedFiles": ["src/file.ts"],
          "checks": [],
          "unresolved": []
        }
      }
    ]
  },
  "expect": {
    "status": "success",
    "visits": ["implement", "implement", "return"],
    "counts": {
      "implement": 2
    },
    "transitions": ["implement->implement", "implement->return"]
  }
}
```
````

The compiler validates the scenario input against the workflow input schema and every mocked successful result against the referenced state output schema. Unknown states, transitions, fields, failure codes, and malformed mock sequences fail test discovery.

## Mock actions

An `invoke` or `local` state may declare an ordered sequence of actions:

- `return` supplies a schema-validated successful result.
- `fail` supplies a typed `Failure`.
- `cancel` supplies a cancellation reason.

Mocks are selected by workflow state ID rather than definition ID. This allows the same agent definition to appear in multiple states with different scripts. By default every declared mock must be consumed.

## Outcome transitions

Transition tables may include an `On` column:

```md
| From | To | On | When | Max traversals |
|---|---|---|---|---|
| `implement` | `implement` | `failure` | | `1` |
| `implement` | `verify` | `success` | | |
```

Supported values are `success`, `failure`, `cancelled`, and `any`. An omitted value means `success`.

A failed or cancelled child follows only an explicitly matching edge. When no matching edge exists, the workflow preserves the original child failure and fails immediately. Retries and fallback agents therefore remain visible, bounded, schema-checked graph states rather than implicit runtime behavior.

## Tool availability

A scenario may define the tool set available to its mocked runtime:

```json
{
  "environment": {
    "availableTools": ["read", "grep", "find", "ls"]
  }
}
```

Before a scripted agent starts, the scenario runner compares this set with the agent definition's tool policy. Missing tools produce `tool_unavailable` with the state ID, definition ID, required tools, missing tools, and available tools.

The separate host preflight test checks every bundled agent policy against the actual test process. Diagnostics distinguish:

- `not_registered`: no built-in or custom implementation exists for the declared tool;
- `executable_not_found`: the tool exists conceptually, but its required executable, such as `bash` or `nix`, is absent from `PATH`.

These checks intentionally fail the canonical repository test graph so a broken development or CI environment is reported before a model session starts.
