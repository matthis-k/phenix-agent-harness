from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "modules/phenix-pi/extensions/phenix-workflow/workflow-store.ts"
content = PATH.read_text()

replacements = [
    (
        '''    throw new WorkflowStoreError(
      "INVALID_RECORD",
      "Persisted workflow record is malformed or uses an unsupported version.",
    );
''',
        '''    throw new WorkflowStoreError(
      "INVALID_RECORD",
      "Persisted workflow record is malformed or uses an unsupported version.",
      {},
    );
''',
    ),
    (
        '    | "UNKNOWN_EXECUTION";\n',
        '    | "UNKNOWN_EXECUTION"\n    | "INVALID_RECORD";\n',
    ),
]

for old, new in replacements:
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match, found {count}: {old[:100]!r}")
    content = content.replace(old, new, 1)

PATH.write_text(content)
