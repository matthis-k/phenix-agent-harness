from pathlib import Path

path = Path("modules/phenix-pi/domain/memory/model.ts")
text = path.read_text()
old = """export interface MemorySnapshot {
  readonly rootRunId: RunId;
  readonly health: MemoryHealthSnapshot;
  readonly evidence: readonly EvidenceRecord[];
"""
new = """export interface MemorySnapshot {
  readonly rootRunId: RunId;
  readonly health: MemoryHealthSnapshot;
  readonly telemetry: MemoryRuntimeTelemetry;
  readonly evidence: readonly EvidenceRecord[];
"""
if old not in text:
    raise SystemExit("MemorySnapshot telemetry marker not found")
path.write_text(text.replace(old, new, 1))
