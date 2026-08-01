from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content)


def replace(path: str, old: str, new: str, expected: int | None = 1) -> None:
    content = read(path)
    count = content.count(old)
    if expected is not None and count != expected:
        raise RuntimeError(f"{path}: expected {expected} occurrences, found {count}: {old!r}")
    write(path, content.replace(old, new))


# Definition baselines stay bounded. Only compiled RunLimits may become unbounded.
replace(
    "modules/phenix-pi/domain/definition/definition.ts",
    "export interface AgentLimits {\n  readonly timeoutMs?: number;\n",
    "export interface AgentLimits {\n  readonly timeoutMs: number;\n",
)
replace(
    "modules/phenix-pi/ports/budget-policy.ts",
    'import type { PiThinkingLevel } from "../domain/definition/model.ts";\n',
    'import type { PiThinkingLevel } from "../domain/definition/model.ts";\nimport type { RunLimits } from "../domain/run/model.ts";\n',
)
replace(
    "modules/phenix-pi/ports/budget-policy.ts",
    "  applyAgentLimits(base: AgentLimits, budget: BudgetMode): AgentLimits;\n",
    "  applyAgentLimits(base: AgentLimits, budget: BudgetMode): RunLimits;\n",
)

# The budget-resume test accepts both bounded and manual-stop compiled runs.
replace(
    "modules/phenix-pi/tests/budget-resume-agent.test.ts",
    'import type { RunRetryLimitOverrides } from "../domain/run/model.ts";\n',
    'import type { RunLimits, RunRetryLimitOverrides } from "../domain/run/model.ts";\n',
)
old_helper = '''function increasedLimit(limits: {
  readonly timeoutMs: number;
  readonly maxTurns?: number;
  readonly maxToolCalls?: number;
  readonly maxRepairAttempts?: number;
}): RunRetryLimitOverrides {
'''
replace(
    "modules/phenix-pi/tests/budget-resume-agent.test.ts",
    old_helper,
    "function increasedLimit(limits: RunLimits): RunRetryLimitOverrides {\n",
)
replace(
    "modules/phenix-pi/tests/budget-resume-agent.test.ts",
    "  if (limits.timeoutMs > 0 && limits.timeoutMs < 3_600_000) {\n",
    "  if (limits.timeoutMs !== undefined && limits.timeoutMs > 0 && limits.timeoutMs < 3_600_000) {\n",
)

# The identity is canonical and unversioned.
replace(
    "modules/phenix-pi/tests/dynamic-workflow-execution.test.ts",
    "  assert.equal(run.compiled.dynamicWorkflow?.identity.version, 1);\n",
    "",
)

# Internal SessionProfile fixtures use the complete normalized shape.
profile_pattern = re.compile(
    r'\{ agent: ("[^"]+"), modelSet: ("[^"]+"), difficulty: ("D[0-3]") \}'
)
profile_updates = 0
for path in (ROOT / "modules/phenix-pi/tests").rglob("*.ts"):
    content = path.read_text()
    updated, count = profile_pattern.subn(
        r'{ agent: \1, modelSet: \2, difficulty: \3, budget: "medium" }',
        content,
    )
    if count:
        path.write_text(updated)
        profile_updates += count
if profile_updates == 0:
    raise RuntimeError("expected incomplete SessionProfile fixtures")

# Test suites inject the framework's neutral budget policy explicitly.
runtime_config = "modules/phenix-pi/tests/runtime-configuration.test.ts"
replace(
    runtime_config,
    'import { defineRuntimeConfiguration } from "../framework/runtime-configuration.ts";\n',
    'import { defineRuntimeConfiguration } from "../framework/runtime-configuration.ts";\nimport { passthroughBudgetPolicy } from "../ports/budget-policy.ts";\n',
)
replace(
    runtime_config,
    "  return {\n    catalog: {\n",
    "  return {\n    budgetPolicy: passthroughBudgetPolicy,\n    catalog: {\n",
)

# The helper deliberately constructs a partial snapshot; make the unsafe fixture cast explicit.
workspace_test = "modules/phenix-pi/tests/workspace-view-registry.test.ts"
content = read(workspace_test)
updated, count = re.subn(r"\}\s+as RunSnapshot,", "} as unknown as RunSnapshot,", content)
if count == 0:
    raise RuntimeError("expected RunSnapshot fixture cast")
write(workspace_test, updated)

print(f"updated {profile_updates} complete session profile fixtures")
