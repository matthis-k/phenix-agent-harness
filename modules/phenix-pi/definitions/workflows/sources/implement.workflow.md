# Implementation workflow

```phenix-workflow
id: workflow.implement
description: Estimate difficulty, use a trivial fast path when safe, otherwise plan, implement, independently verify, and perform bounded repairs.
input: request.implementation
output: outcome.implementation-result
entry: estimate
timeout-ms: 2400000
max-node-runs: 24
max-parallelism: 1
```

## Flow

```mermaid
flowchart LR
    estimate[Estimate difficulty] -->|D0| implement[Implement]
    estimate -->|D1-D3| plan[Plan]
    plan --> implement
    implement -->|D0| trivial[Deterministic acceptance]
    trivial --> trivialDecision{Accepted?}
    trivialDecision -->|yes| return([Return result])
    trivialDecision -->|no| fail([Fail])
    implement -->|D1-D3| verify[Independent verification]
    verify --> accepted{Accepted?}
    accepted -->|accepted| return
    accepted -->|repair; at most 2| implement
    accepted -->|exhausted| fail
```

## States

### estimate

```phenix-state
kind: invoke
title: Estimate task difficulty
run: agent.difficulty-estimator
input: difficulty.input
input-schema: request.difficulty-assessment
output-schema: outcome.difficulty-assessment
wait: await
difficulty: D0
retry: retryable
max-retries: 1
```

### plan

```phenix-state
kind: invoke
title: Produce an executable plan
run: agent.planner
input: implement.plan.input
input-schema: request.plan
output-schema: outcome.plan
wait: await
difficulty: result:estimate
retry: retryable
max-retries: 1
```

### implement

```phenix-state
kind: invoke
title: Apply the current implementation attempt
run: agent.implementer
input: implement.work.input
input-schema: request.implementation
output-schema: outcome.change-set
wait: await
difficulty: result:estimate
```

### trivial-accept

```phenix-state
kind: local
title: Accept a trivial change only from deterministic evidence
operation: local.noop
input: implement.trivial-verification
input-schema: outcome.verification
output-schema: outcome.verification
```

### trivial-decision

```phenix-state
kind: decision
decide: implement.trivial-acceptance
```

### verify

```phenix-state
kind: invoke
title: Independently verify the attempt
run: agent.verifier
input: implement.verify.input
input-schema: request.verification
output-schema: outcome.verification
wait: await
difficulty: result:estimate
retry: retryable
max-retries: 1
```

### accepted

```phenix-state
kind: decision
decide: implement.acceptance
```

### return

```phenix-state
kind: return
output: implement.output
output-schema: outcome.implementation-result
```

### fail

```phenix-state
kind: fail
reason: implement.failure
```

## Transitions

| From | To | When | Max traversals |
|---|---|---|---|
| `estimate` | `implement` | `difficulty.D0` | |
| `estimate` | `plan` | `difficulty.at-least-D1` | |
| `plan` | `implement` | | |
| `implement` | `trivial-accept` | `difficulty.D0` | |
| `trivial-accept` | `trivial-decision` | | |
| `trivial-decision` | `return` | `decision.accepted` | |
| `trivial-decision` | `fail` | `decision.exhausted` | |
| `implement` | `verify` | `difficulty.at-least-D1` | `3` |
| `verify` | `accepted` | | `3` |
| `accepted` | `return` | `decision.accepted` | |
| `accepted` | `implement` | `decision.repair` | `2` |
| `accepted` | `fail` | `decision.exhausted` | |

## Tests

### d0-deterministic-success

```phenix-test
{
  "input": {
    "objective": "Apply a trivial targeted change"
  },
  "mocks": {
    "estimate": [
      {
        "return": {
          "difficulty": "D0",
          "summary": "Trivial targeted change",
          "signals": ["single bounded edit"]
        }
      }
    ],
    "implement": [
      {
        "return": {
          "summary": "Applied targeted change",
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
    "trivial-accept": [
      {
        "return": {
          "accepted": true,
          "summary": "Deterministic evidence accepted",
          "findings": [],
          "evidence": ["devenv test passed"]
        }
      }
    ]
  },
  "expect": {
    "status": "success",
    "visits": [
      "estimate",
      "implement",
      "trivial-accept",
      "trivial-decision",
      "return"
    ],
    "transitions": [
      "estimate->implement",
      "implement->trivial-accept",
      "trivial-accept->trivial-decision",
      "trivial-decision->return"
    ]
  }
}
```

### deterministic-rejection

```phenix-test
{
  "input": {
    "objective": "Reject a trivial change that lacks deterministic evidence"
  },
  "mocks": {
    "estimate": [
      {
        "return": {
          "difficulty": "D0",
          "summary": "Trivial targeted change",
          "signals": ["single bounded edit"]
        }
      }
    ],
    "implement": [
      {
        "return": {
          "summary": "Applied incomplete targeted change",
          "changedFiles": ["src/file.ts"],
          "checks": [],
          "unresolved": ["No deterministic check passed"]
        }
      }
    ],
    "trivial-accept": [
      {
        "return": {
          "accepted": false,
          "summary": "Deterministic evidence rejected",
          "findings": ["No successful targeted check was reported."],
          "evidence": []
        }
      }
    ]
  },
  "expect": {
    "status": "failure",
    "visits": [
      "estimate",
      "implement",
      "trivial-accept",
      "trivial-decision",
      "fail"
    ],
    "transitions": [
      "estimate->implement",
      "implement->trivial-accept",
      "trivial-accept->trivial-decision",
      "trivial-decision->fail"
    ],
    "failure": {
      "code": "workflow_rejected",
      "messageIncludes": "Implementation was rejected after 1 attempts"
    }
  }
}
```

### repair-once

```phenix-test
{
  "input": {
    "objective": "Implement a non-trivial change"
  },
  "mocks": {
    "estimate": [
      {
        "return": {
          "difficulty": "D1",
          "summary": "Requires planning and verification",
          "signals": ["behavioral change"]
        }
      }
    ],
    "plan": [
      {
        "return": {
          "summary": "Plan the implementation",
          "steps": ["edit implementation", "run tests"],
          "constraints": [],
          "checks": ["devenv test"]
        }
      }
    ],
    "implement": [
      {
        "return": {
          "summary": "Initial implementation",
          "changedFiles": ["src/file.ts"],
          "checks": [],
          "unresolved": []
        }
      },
      {
        "return": {
          "summary": "Repaired implementation",
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
          "accepted": false,
          "summary": "Repair required",
          "findings": ["Missing regression handling"],
          "evidence": []
        }
      },
      {
        "return": {
          "accepted": true,
          "summary": "Accepted after repair",
          "findings": [],
          "evidence": ["devenv test passed"]
        }
      }
    ]
  },
  "expect": {
    "status": "success",
    "visits": [
      "estimate",
      "plan",
      "implement",
      "verify",
      "accepted",
      "implement",
      "verify",
      "accepted",
      "return"
    ],
    "counts": {
      "implement": 2,
      "verify": 2
    },
    "transitions": [
      "estimate->plan",
      "plan->implement",
      "implement->verify",
      "verify->accepted",
      "accepted->implement",
      "implement->verify",
      "verify->accepted",
      "accepted->return"
    ]
  }
}
```

### unavailable-implementer-tools

```phenix-test
{
  "input": {
    "objective": "Apply a trivial targeted change"
  },
  "environment": {
    "availableTools": []
  },
  "mocks": {
    "estimate": [
      {
        "return": {
          "difficulty": "D0",
          "summary": "Trivial targeted change",
          "signals": ["single bounded edit"]
        }
      }
    ]
  },
  "expect": {
    "status": "failure",
    "visits": ["estimate", "implement"],
    "failure": {
      "code": "tool_unavailable",
      "messageIncludes": "nix_shell"
    }
  }
}
```
