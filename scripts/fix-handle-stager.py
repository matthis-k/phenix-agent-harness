from pathlib import Path

path = Path("scripts/apply-handle-first-subagent-fix.py")
text = path.read_text()
old = '''replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-action-schema.ts",
    '    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),',
    '    mode: Type.Optional(WorkflowModeInput),',
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-action-schema.ts",
    '    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),',
    '    mode: Type.Optional(WorkflowModeInput),',
)
'''
new = '''schema_path = ROOT / "modules/phenix-pi/packages/phenix-suite/runtime/workflow-action-schema.ts"
schema_text = schema_path.read_text()
mode_input = '    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])), '
mode_input = mode_input.rstrip()
if schema_text.count(mode_input) != 2:
    raise RuntimeError(f"expected two workflow mode inputs, found {schema_text.count(mode_input)}")
schema_path.write_text(schema_text.replace(mode_input, '    mode: Type.Optional(WorkflowModeInput),'))
'''
if text.count(old) != 1:
    raise RuntimeError(f"stager replacement block count was {text.count(old)}")
path.write_text(text.replace(old, new, 1))
