from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative: str, old: str, new: str) -> None:
    path = ROOT / relative
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{relative}: expected one occurrence, found {count}: {old[:120]!r}")
    path.write_text(text.replace(old, new, 1))


def write(relative: str, content: str) -> None:
    path = ROOT / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


replace_once(
    "modules/phenix-pi/domain/shared.ts",
    '  | "workflow_runtime_failed"\n  | "workflow_exhausted"',
    '  | "workflow_runtime_failed"\n  | "workflow_rejected"\n  | "workflow_exhausted"',
)

replace_once(
    "modules/phenix-pi/domain/shared.ts",
    '''export interface FailureReport {
  readonly source: "agent" | "automatic";
  readonly category: FailureCategory;
  readonly summary: string;
  readonly retryable: boolean;
  readonly requestedTools?: readonly string[];
  readonly suggestedLimits?: FailureLimitSuggestion;
}

export interface Failure {''',
    '''export interface FailureReport {
  readonly source: "agent" | "automatic";
  readonly category: FailureCategory;
  readonly summary: string;
  readonly retryable: boolean;
  readonly requestedTools?: readonly string[];
  readonly suggestedLimits?: FailureLimitSuggestion;
}

export function defaultAgentFailureRetryable(
  category: FailureCategory,
  suggestedLimits?: FailureLimitSuggestion,
): boolean {
  if (category === "external_failure") return true;
  if (category !== "resource_limit" || suggestedLimits === undefined) return false;
  return Object.values(suggestedLimits).some((value) => value !== undefined);
}

export interface Failure {''',
)

replace_once(
    "modules/phenix-pi/application/agent-executor.ts",
    '''import type {
  Failure,
  FailureCategory,
  FailureLimitSuggestion,
  FailureReport,
  RunId,
} from "../domain/shared.ts";''',
    '''import {
  defaultAgentFailureRetryable,
  type Failure,
  type FailureCategory,
  type FailureLimitSuggestion,
  type FailureReport,
  type RunId,
} from "../domain/shared.ts";''',
)

replace_once(
    "modules/phenix-pi/application/agent-executor.ts",
    '''          const report: FailureReport = {
            source: "agent",
            category: validation.value.category ?? "other",
            summary: validation.value.summary,
            retryable: validation.value.retryable ?? true,
            ...(validation.value.requestedTools
              ? { requestedTools: validation.value.requestedTools }
              : {}),
            ...(validation.value.suggestedLimits
              ? { suggestedLimits: validation.value.suggestedLimits }
              : {}),
          };''',
    '''          const category = validation.value.category ?? "other";
          const report: FailureReport = {
            source: "agent",
            category,
            summary: validation.value.summary,
            retryable:
              validation.value.retryable ??
              defaultAgentFailureRetryable(category, validation.value.suggestedLimits),
            ...(validation.value.requestedTools
              ? { requestedTools: validation.value.requestedTools }
              : {}),
            ...(validation.value.suggestedLimits
              ? { suggestedLimits: validation.value.suggestedLimits }
              : {}),
          };''',
)

replace_once(
    "modules/phenix-pi/application/agent-executor.ts",
    "- If blocked, deadlocked, missing permissions, or unable to produce a valid result, call phenix_fail with a short report instead of looping or inventing success.\\n- Budget exhaustion suspends the same Pi session.",
    "- If blocked, deadlocked, missing permissions, or unable to produce a valid result, call phenix_fail with a short report instead of looping or inventing success.\\n- Omitted retryability is conservative: only external failures and resource-limit reports with a concrete limit suggestion retry by default; set retryable explicitly when the situation differs.\\n- Budget exhaustion suspends the same Pi session.",
)

replace_once(
    "modules/phenix-pi/domain/workflow/planner.ts",
    '''        failure: {
          code: "workflow_exhausted",
          message: `Join ${node.id} observed a failed branch`,
          retryable: false,
        },''',
    '''        failure: {
          code: "workflow_rejected",
          message: `Join ${node.id} observed a failed required branch`,
          retryable: false,
        },''',
)

replace_once(
    "modules/phenix-pi/application/workflow-process-manager.ts",
    '''        await this.controller.fail(run.id, {
          code: "workflow_exhausted",
          message,
          retryable: false,
        });''',
    '''        await this.controller.fail(run.id, {
          code: "workflow_rejected",
          message,
          retryable: false,
        });''',
)

replace_once(
    "modules/phenix-pi/adapters/workflow/scenario-markdown.ts",
    '  "workflow_runtime_failed",\n  "workflow_exhausted",',
    '  "workflow_runtime_failed",\n  "workflow_rejected",\n  "workflow_exhausted",',
)

join_test = r'''test("strict joins classify a required branch failure as workflow rejection", () => {
  const workflow = definition(
    [
      {
        kind: "invoke",
        id: "left",
        definition: { id: definitionId("agent.test") },
        input: "mapping.left",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "right",
        definition: { id: definitionId("agent.test") },
        input: "mapping.right",
        wait: "await",
      },
      { kind: "join", id: "join", policy: "all-success" },
    ],
    [
      { from: "left", to: "join" },
      { from: "right", to: "join" },
    ],
  );
  const results = new Map<string, readonly unknown[]>([
    [
      "left",
      [failed({ code: "agent_reported_failure", message: "rejected", retryable: false })],
    ],
  ]);
  const transitions = new Map([["left->join", 1]]);

  const result = plan(
    state(workflow, [{ id: "activation-join", nodeId: "join", sequence: 3 }], {
      results,
      transitions,
    }),
  );

  assert.equal(result.kind, "fail-workflow");
  if (result.kind === "fail-workflow") {
    assert.equal(result.failure.code, "workflow_rejected");
    assert.match(result.failure.message, /failed required branch/);
  }
});

'''
replace_once(
    "modules/phenix-pi/tests/workflow-planner.test.ts",
    'test("parallelism pressure becomes an explicit wait plan", () => {',
    join_test + 'test("parallelism pressure becomes an explicit wait plan", () => {',
)

replace_once(
    "modules/phenix-pi/tests/graceful-recovery.test.ts",
    '''  assert.equal(failed.failure.code, "agent_reported_failure");
  const report = failed.failure.details as FailureReport;
  assert.equal(report.category, "deadlock");''',
    '''  assert.equal(failed.failure.code, "agent_reported_failure");
  assert.equal(failed.failure.retryable, true);
  const report = failed.failure.details as FailureReport;
  assert.equal(report.category, "deadlock");
  assert.equal(report.retryable, true);''',
)

write(
    "modules/phenix-pi/tests/failure-policy.test.ts",
    '''import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultAgentFailureRetryable,
  type FailureCategory,
} from "../domain/shared.ts";

test("structural agent failures are not retried by default", () => {
  const structural: readonly FailureCategory[] = [
    "blocked",
    "deadlock",
    "insufficient_permissions",
    "invalid_task",
    "other",
  ];

  for (const category of structural) {
    assert.equal(defaultAgentFailureRetryable(category), false, category);
  }
});

test("only transient or actionable resource failures retry by default", () => {
  assert.equal(defaultAgentFailureRetryable("external_failure"), true);
  assert.equal(defaultAgentFailureRetryable("resource_limit"), false);
  assert.equal(defaultAgentFailureRetryable("resource_limit", {}), false);
  assert.equal(defaultAgentFailureRetryable("resource_limit", { maxTurns: null }), true);
  assert.equal(defaultAgentFailureRetryable("resource_limit", { timeoutMs: 120_000 }), true);
});
''',
)

rejection_scenario = r'''### deterministic-rejection

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

'''
replace_once(
    "modules/phenix-pi/definitions/workflows/sources/implement.workflow.md",
    "### repair-once\n",
    rejection_scenario + "### repair-once\n",
)

replace_once(
    "docs/WORKFLOW_FAILURES.md",
    "| Quality rejection | Independent verifier rejects an implementation after bounded repair attempts | Yes | Fail as a valid negative result. Do not retry the side-effecting implementation activation automatically. |",
    "| Quality rejection | Independent verifier rejects an implementation after bounded repair attempts | Yes | Fail with `workflow_rejected`. Do not retry the side-effecting implementation activation automatically. |",
)
replace_once(
    "docs/WORKFLOW_FAILURES.md",
    "| Strict branch failure | One required branch of an `all-success` join fails after its retry policy | Yes | Fail the workflow. Missing a required architecture, security, test, or evidence branch would make the result incomplete. |",
    "| Strict branch failure | One required branch of an `all-success` join fails after its retry policy | Yes | Fail with `workflow_rejected`. Missing a required architecture, security, test, or evidence branch would make the result incomplete. |",
)
replace_once(
    "docs/WORKFLOW_FAILURES.md",
    "1. **Retries are opt-in and bounded.** Only awaited invocation states declaring `retry: retryable` may replace a failed child, and only when the resulting child failure is marked retryable.",
    "1. **Retries are opt-in and bounded.** Only awaited invocation states declaring `retry: retryable` may replace a failed child, and only when the resulting child failure is marked retryable. Omitted agent retryability is derived conservatively from the failure category rather than assumed true.",
)

doc_path = ROOT / "docs/WORKFLOW_FAILURES.md"
doc = doc_path.read_text()
heading = "## Known classification limitations\n"
if doc.count(heading) != 1:
    raise RuntimeError("docs/WORKFLOW_FAILURES.md: expected one known-limitations heading")
doc = doc.split(heading, 1)[0] + '''## Typed classification and retry defaults

`workflow_exhausted` is reserved for an exhausted orchestration mechanism, such as the workflow node-activation limit. It does not describe a valid negative quality result.

`workflow_rejected` represents a deliberate terminal rejection produced by a workflow fail node or a failed required branch of an `all-success` join. This keeps verifier rejection, deterministic acceptance failure, and incomplete strict evidence distinct from runtime exhaustion.

When an agent omits `retryable`, the runtime derives the default from the structured category:

| Category | Default | Rationale |
|---|---:|---|
| `external_failure` | Retryable | Provider and transport failures may be transient. |
| `resource_limit` with at least one concrete suggested limit | Retryable | A replacement attempt can apply a validated limit change. |
| `resource_limit` without a concrete suggestion | Not retryable | Repeating the same limits cannot repair the failure. |
| `blocked`, `deadlock`, `insufficient_permissions`, `invalid_task`, `other` | Not retryable | The input, authority, dependency, or execution plan must change first. |

An explicit `retryable` value remains authoritative. This permits a caller or agent to mark an unusual structural incident transient, but omission can no longer accidentally enable automatic retry.
'''
doc_path.write_text(doc)

(ROOT / ".github/workflows/apply-workflow-failure-fix.yml").unlink()
Path(__file__).unlink()
