# Workflow tests

Workflow Markdown may include an optional `## Tests` section. Each `###` subsection defines one scenario with a JSON `phenix-test` block.

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

The scenario input and successful mocked results are validated against their registered schemas. Unknown states, transitions, fields, failure codes, and unused mock actions fail test discovery.

## Mock actions

An `invoke` or `local` state may use an ordered sequence of:

- `return`: schema-valid success value;
- `fail`: typed failure;
- `cancel`: cancellation reason.

Mocks are keyed by workflow state ID, so separate states using the same definition may have different scripts.

## Outcome transitions

A transition table may include an `On` column:

```md
| From | To | On | When | Max traversals |
|---|---|---|---|---|
| `implement` | `implement` | `failure` | | `1` |
| `implement` | `verify` | `success` | | |
```

Supported outcomes are `success`, `failure`, `cancelled`, and `any`. Omitted means `success`. A failure or cancellation with no matching edge ends the workflow with the original child outcome.

## Available tools

A scenario may define the tools visible to mocked agents:

```json
{
  "environment": {
    "availableTools": ["read", "grep", "find", "ls"]
  }
}
```

Missing required tools produce `tool_unavailable`. Repository tests also verify that every bundled tool is registered and that required executables are present.
