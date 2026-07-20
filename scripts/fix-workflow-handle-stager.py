from pathlib import Path

path = Path("scripts/apply-workflow-handle-deadlock-qa-fanout.py")
text = path.read_text()
old = '''replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    '  readonly actorRoles: ReadonlyArray<"coordinator" | AgentKind>;',
    "  readonly actorRoles: readonly WorkflowActorRole[];",
)
'''
new = '''workflow_path = ROOT / "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts"
workflow_text = workflow_path.read_text()
old_actor_roles = '  readonly actorRoles: ReadonlyArray<"coordinator" | AgentKind>;'
if workflow_text.count(old_actor_roles) != 2:
    raise RuntimeError(
        f"modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts: expected two actorRoles declarations, found {workflow_text.count(old_actor_roles)}"
    )
workflow_path.write_text(
    workflow_text.replace(old_actor_roles, "  readonly actorRoles: readonly WorkflowActorRole[];")
)
'''
if text.count(old) != 2:
    raise RuntimeError(f"expected two staged actorRoles replacements, found {text.count(old)}")
# Replace the first block with one exact two-occurrence source edit and remove the duplicate block.
text = text.replace(old, new, 1).replace(old, "", 1)
path.write_text(text)
