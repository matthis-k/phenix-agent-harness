from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    target = ROOT / path
    content = target.read_text()
    count = content.count(old)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} matches, found {count}: {old[:100]!r}")
    target.write_text(content.replace(old, new, expected))


for path in [
    "modules/phenix-pi/extensions/phenix-subagents/contract.ts",
    "modules/phenix-pi/extensions/phenix-subagents/child-spec.ts",
    "modules/phenix-pi/extensions/phenix-workflow/session-registry.ts",
    "modules/phenix-pi/extensions/phenix-workflow/workflow-store.ts",
]:
    replace(path, "WorkflowDefinitionId", "DefaultWorkflowDefinitionId")

replace(
    "modules/phenix-pi/extensions/phenix-workflow/index.ts",
    "  WorkflowDefinitionId,\n",
    "  DefaultWorkflowDefinitionId,\n",
)
