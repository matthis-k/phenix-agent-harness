from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old!r}")
    target.write_text(content.replace(old, new, 1))


replace(
    "modules/phenix-pi/ports/budget-policy.ts",
    "  applyAgentLimits: (base) => base,\n  capThinking: (requested) => requested,\n",
    "  applyAgentLimits: (base: AgentLimits) => base,\n  capThinking: (requested: PiThinkingLevel) => requested,\n",
)
replace(
    "modules/phenix-pi/suite/phenix-budget-policy.ts",
    "  applyAgentLimits(base, budget) {\n",
    "  applyAgentLimits(base: AgentLimits, budget: BudgetMode) {\n",
)
replace(
    "modules/phenix-pi/suite/phenix-budget-policy.ts",
    "  capThinking(requested, budget) {\n",
    "  capThinking(requested: PiThinkingLevel, budget: BudgetMode) {\n",
)
replace(
    "modules/phenix-pi/tests/phenix-ui.test.ts",
    '    difficulty: "D1",\n  } satisfies SessionProfile;\n',
    '    difficulty: "D1",\n    budget: "medium",\n  } satisfies SessionProfile;\n',
)
replace(
    "modules/phenix-pi/tests/run-monitor.test.ts",
    '    profile: { agent: "base" as const, modelSet: "mixed" as const, difficulty: "D2" as const },\n',
    '    profile: {\n      agent: "base" as const,\n      modelSet: "mixed" as const,\n      difficulty: "D2" as const,\n      budget: "medium" as const,\n    },\n',
)

print("final budget type fixes applied")
