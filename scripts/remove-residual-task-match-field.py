import re
from pathlib import Path

path = Path("modules/phenix-pi/packages/phenix-suite/composition/workflow-turn-gate.ts")
text = path.read_text()
updated, count = re.subn(r"^\s*mustMatchUserTask: false,\n", "", text, flags=re.MULTILINE)
if count != 1:
    raise RuntimeError(f"expected one residual mustMatchUserTask field, found {count}")
path.write_text(updated)
