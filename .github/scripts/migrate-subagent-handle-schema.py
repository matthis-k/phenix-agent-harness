from pathlib import Path
import re

root = Path("modules/phenix-pi")

handle_types = root / "extensions/phenix-subagents/handle-types.ts"
text = handle_types.read_text()
text = text.replace(
'''import type {
  ChildRunId,
  ChildSessionBackendKind,
  SerializedError,
} from "../phenix-runtime/child-session-types.ts";
''',
'''import type { SerializedError } from "../phenix-runtime/child-session-types.ts";
''')
text = text.replace("export const HANDLE_VERSION = 4;", "export const HANDLE_VERSION = 5;")
text = text.replace(
'''  error?: SerializedError;

  // Child session summaries (for multi-session cycles)
  childSessions?: readonly ChildSessionSummary[];
}

export interface ChildSessionSummary {
  readonly role: string;
  readonly status: "completed" | "failed";
  readonly sessionFile?: string;
  readonly transcriptPath?: string;
}
''',
'''  error?: SerializedError;
}
''')
text = text.replace("// ── Handle record (version 2) ─", "// ── Handle record (version 5) ─")
text = text.replace(
'''  // ── Child session linkage (distinct from Pi session IDs) ────────────
  childRunId?: ChildRunId;
  rootChildRunId?: ChildRunId;
  backend?: ChildSessionBackendKind;
  piSessionId?: string;
  piSessionFile?: string;
''',
'''  // ── Managed subagent linkage ───────────────────────────────────────
  subagentId?: string;
  rootSubagentId?: string;
''')
text = text.replace("through a v4 workflow transition", "through a v5 workflow transition")
text = text.replace("// ── Workflow binding (v4) ─", "// ── Workflow binding (v5) ─")
text = re.sub(
    r'\n// ── Extended handle record with workflow binding.*?\nexport interface HandleRecordWithWorkflow extends HandleRecord \{\n  readonly workflowBinding: WorkflowBinding;\n\}\n',
    "\n",
    text,
    count=1,
    flags=re.S,
)
handle_types.write_text(text)

runtime = root / "extensions/phenix-subagents/managed-delegation-runtime.ts"
text = runtime.read_text()
text = text.replace(
'import type { ChildRunId } from "../phenix-runtime/child-session-types.ts";\nimport { ChildRuntimeError } from "../phenix-runtime/child-session-types.ts";\n',
'import { ChildRuntimeError } from "../phenix-runtime/child-session-types.ts";\n')
text = text.replace("readonly rootChildRunId: ChildRunId;", "readonly rootSubagentId: string;")
text = text.replace("input.record.childRunId = handle.id as ChildRunId;", "input.record.subagentId = handle.id;")
text = text.replace("input.record.rootChildRunId = input.rootChildRunId;", "input.record.rootSubagentId = input.rootSubagentId;")
text = text.replace("record.childRunId", "record.subagentId")
runtime.write_text(text)

coordinator = root / "extensions/phenix-subagents/coordinator.ts"
text = coordinator.read_text().replace("rootChildRunId: rootRunId,", "rootSubagentId: rootRunId,")
coordinator.write_text(text)

quality = root / "extensions/phenix-subagents/execution-quality-service.ts"
text = quality.read_text()
text = text.replace(
'''    const runId = childRunId(`critic_${input.record.id}_${randomUUID()}`);
    const rootRunId = input.record.rootChildRunId ?? input.record.childRunId ?? runId;
''',
'''    const runId = childRunId(`critic_${input.record.id}_${randomUUID()}`);
    const parentRunId = input.record.subagentId ? childRunId(input.record.subagentId) : undefined;
    const rootRunId = input.record.rootSubagentId
      ? childRunId(input.record.rootSubagentId)
      : (parentRunId ?? runId);
''')
text = text.replace(
'        ...(input.record.childRunId ? { parentId: input.record.childRunId } : {}),',
'        ...(parentRunId ? { parentId: parentRunId } : {}),')
quality.write_text(text)

index = root / "extensions/phenix-subagents/index.ts"
text = index.read_text()
text = text.replace("childRunId: record.childRunId,", "subagentId: record.subagentId,")
text = text.replace("    piSessionId: record.piSessionId,\n", "")
text = text.replace("    backend: record.backend,\n", "")
text = text.replace("      childRunId: r.childRunId,", "      subagentId: r.subagentId,")
text = text.replace("      rootChildRunId: r.rootChildRunId,", "      rootSubagentId: r.rootSubagentId,")
text = text.replace("      piSessionId: r.piSessionId,\n", "")
index.write_text(text)

for test in (root / "tests").glob("*.ts"):
    text = test.read_text().replace("version: 4,", "version: 5,")
    if test.name == "managed-delegation-runtime.test.ts":
        text = text.replace(
            'import type { ChildRunId } from "../extensions/phenix-runtime/child-session-types.ts";\n',
            "",
        )
        text = text.replace(
            "function runningRecord(childRunId: ChildRunId): HandleRecord {",
            "function runningRecord(subagentId: string): HandleRecord {",
        )
        text = text.replace(
            "    childRunId,\n    rootChildRunId: childRunId,",
            "    subagentId,\n    rootSubagentId: subagentId,",
        )
        text = text.replace(
            'const childRunId = "managed-failure" as ChildRunId;',
            'const subagentId = "managed-failure";',
        )
        text = text.replace(
            'const childRunId = "managed-wait-cancelled" as ChildRunId;',
            'const subagentId = "managed-wait-cancelled";',
        )
        text = text.replace("runningRecord(childRunId)", "runningRecord(subagentId)")
        text = text.replace("        childRunId,", "        subagentId,")
    test.write_text(text)

stale = []
for path in [handle_types, runtime, quality, index]:
    content = path.read_text()
    for token in [
        "piSessionId",
        "piSessionFile",
        "rootChildRunId",
        "record.childRunId",
        "ChildSessionSummary",
        "HandleRecordWithWorkflow",
    ]:
        if token in content:
            stale.append(f"{path}: {token}")
if stale:
    raise RuntimeError("stale persisted-handle vocabulary remains:\n" + "\n".join(stale))
