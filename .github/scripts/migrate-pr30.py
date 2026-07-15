from pathlib import Path

coordinator = Path("modules/phenix-pi/extensions/phenix-subagents/coordinator.ts")
text = coordinator.read_text()
old = "      record.childRunId = handle.id;"
new = "      record.childRunId = childRunId(handle.id);"
if text.count(old) != 1:
    raise RuntimeError("expected one managed handle ID assignment")
coordinator.write_text(text.replace(old, new))
