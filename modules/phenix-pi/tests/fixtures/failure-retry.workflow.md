# Failure retry workflow fixture

```phenix-workflow
id: workflow.test-failure-retry
description: Exercise bounded in-place child recovery and retry exhaustion.
input: request.implementation.v1
output: outcome.implementation-result.v1
entry: implement
timeout-ms: 30000
max-node-runs: 6
max-parallelism: 1
```

## States

### implement

```phenix-state
kind: invoke
run: agent.implementer
input: implement.work.input
input-schema: request.implementation.v1
output-schema: outcome.change-set.v1
wait: await
retry: retryable
max-retries: 1
```

### verify

```phenix-state
kind: invoke
run: agent.verifier
input: implement.verify.input
input-schema: request.verification.v1
output-schema: outcome.verification.v1
wait: await
```

### return

```phenix-state
kind: return
output: implement.output
output-schema: outcome.implementation-result.v1
```

## Transitions

| From | To | On | When | Max traversals |
|---|---|---|---|---|
| `implement` | `verify` | `success` | | |
| `verify` | `return` | `success` | | |

## Tests

### retry-then-succeed

```phenix-test
{
  "input": {
    "objective": "Implement a change after a transient tool failure"
  },
  "mocks": {
    "implement": [
      {
        "fail": {
          "code": "tool_unavailable",
          "message": "nix was not found in PATH",
          "retryable": true,
          "details": {
            "tool": "nix_shell",
            "reason": "executable_not_found"
          }
        }
      },
      {
        "return": {
          "summary": "Implemented after retry",
          "changedFiles": ["src/file.ts"],
          "checks": [
            {
              "command": "devenv test",
              "ok": true,
              "summary": "passed"
            }
          ],
          "unresolved": []
        }
      }
    ],
    "verify": [
      {
        "return": {
          "accepted": true,
          "summary": "Accepted",
          "findings": [],
          "evidence": ["devenv test passed"]
        }
      }
    ]
  },
  "expect": {
    "status": "success",
    "visits": ["implement", "verify", "return"],
    "counts": {
      "implement": 1,
      "verify": 1
    },
    "transitions": [
      "implement->verify",
      "verify->return"
    ],
    "requireAllMocksConsumed": true
  }
}
```

### retry-exhausted

```phenix-test
{
  "input": {
    "objective": "Fail after the declared retry is exhausted"
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
        "fail": {
          "code": "tool_unavailable",
          "message": "nix remains unavailable after retry",
          "retryable": false
        }
      }
    ]
  },
  "expect": {
    "status": "failure",
    "visits": ["implement"],
    "counts": {
      "implement": 1
    },
    "transitions": [],
    "failure": {
      "code": "tool_unavailable",
      "messageIncludes": "remains unavailable"
    },
    "requireAllMocksConsumed": true
  }
}
```
