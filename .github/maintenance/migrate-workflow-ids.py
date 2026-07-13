from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_all(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    count = content.count(old)
    if count == 0:
        raise RuntimeError(f"{path}: expected at least one match: {old[:100]!r}")
    target.write_text(content.replace(old, new))


for path in [
    "modules/phenix-pi/extensions/phenix-subagents/contract.ts",
    "modules/phenix-pi/extensions/phenix-subagents/child-spec.ts",
    "modules/phenix-pi/extensions/phenix-workflow/session-registry.ts",
    "modules/phenix-pi/extensions/phenix-workflow/workflow-store.ts",
]:
    replace_all(path, "WorkflowDefinitionId", "DefaultWorkflowDefinitionId")

replace_all(
    "modules/phenix-pi/extensions/phenix-workflow/index.ts",
    "WorkflowDefinitionId",
    "DefaultWorkflowDefinitionId",
)
