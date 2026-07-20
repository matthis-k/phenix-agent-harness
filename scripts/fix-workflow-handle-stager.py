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
text = text.replace(old, new, 1).replace(old, "", 1)

anchor = '''replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    """  WorkflowOutputSchemaId,
'''
addition = '''replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    'function actorClientRefs(roles: ReadonlyArray<"coordinator" | AgentKind>) {',
    "function actorClientRefs(roles: readonly WorkflowActorRole[]) {",
)

'''
if text.count(anchor) != 1:
    raise RuntimeError(f"workflow import anchor count was {text.count(anchor)}")
text = text.replace(anchor, addition + anchor, 1)
path.write_text(text)
