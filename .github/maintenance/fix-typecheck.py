from pathlib import Path

root = Path(__file__).resolve().parents[2]
path = root / "modules/phenix-pi/extensions/phenix.ts"
content = path.read_text()

replacements = [
    (
        '    await mod.default(api, { interceptors: { github: true } });\n',
        '    await mod.default(api);\n',
    ),
    (
        '      return [delegationTool];\n',
        '''      // ToolDefinition is invariant in its schema-derived argument type.
      // Child sessions intentionally accept heterogeneous Pi tools, so erase the
      // concrete schema only at this composition boundary.
      return [delegationTool as unknown as ToolDefinition];
''',
    ),
]

for old, new in replacements:
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match, found {count}: {old!r}")
    content = content.replace(old, new, 1)

path.write_text(content)
