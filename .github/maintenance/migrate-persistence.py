from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:100]!r}")
    target.write_text(content.replace(old, new, 1))


def remove_between(path: str, start: str, end: str) -> None:
    target = ROOT / path
    content = target.read_text()
    start_index = content.index(start)
    end_index = content.index(end, start_index)
    target.write_text(content[:start_index] + end + content[end_index + len(end):])


# Contract store: reuse atomic JSON and missing-file mechanics while retaining
# the contract-specific codec and in-process exclusive queue.
contract = "modules/phenix-pi/extensions/phenix-subagents/contract-store.ts"
replace_once(contract, 'import { randomUUID } from "node:crypto";\n', "")
replace_once(
    contract,
    'import {\n  decodeContractArtifact,\n} from "./contract-codec.ts";\n',
    'import { decodeContractArtifact } from "./contract-codec.ts";\n'
    'import {\n'
    '  atomicWriteJson,\n'
    '  isErrno,\n'
    '  readJsonFile,\n'
    '} from "../phenix-persistence/json-files.ts";\n',
)
remove_between(
    contract,
    "// ── Atomic file writes ──────────────────────────────────────────────────────\n",
    "// ── Result decoding ─────────────────────────────────────────────────────────\n",
)
replace_once(
    contract,
    '''        if (
          (error as NodeJS.ErrnoException).code !==
          "ENOENT"
        ) {
          throw error;
        }
''',
    '''        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
''',
)
old_load = '''    try {
      const artifactRaw = JSON.parse(
        fs.readFileSync(this.artifactPath(id), "utf-8"),
      );

      // Use the integrated codec for deep validation.
      const artifact = decodeContractArtifact(artifactRaw);

      const resultRaw = JSON.parse(
        fs.readFileSync(this.resultPath(id), "utf-8"),
      );

      const result = decodeResult(resultRaw);

      return { artifact, result };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code ===
        "ENOENT"
      ) {
        return undefined;
      }
'''
new_load = '''    try {
      const artifact = readJsonFile(
        this.artifactPath(id),
        decodeContractArtifact,
      );
      const result = readJsonFile(this.resultPath(id), decodeResult);

      if (!artifact || !result) return undefined;
      return { artifact, result };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
'''
replace_once(contract, old_load, new_load)

# Workflow store: share filesystem mechanics, validate persisted envelopes, and
# remove the unrestricted overwrite API. Revision-safe mutation remains the
# only update path for existing records.
workflow = "modules/phenix-pi/extensions/phenix-workflow/workflow-store.ts"
replace_once(
    workflow,
    'import { createHash, randomUUID } from "node:crypto";\n',
    'import { createHash, randomUUID } from "node:crypto";\n',
)
replace_once(
    workflow,
    'import { isTerminalState } from "./workflow-reducer.ts";\n',
    'import {\n'
    '  atomicWriteJson,\n'
    '  isErrno,\n'
    '  readJsonFile,\n'
    '  sanitizePathSegment,\n'
    '  timestamp,\n'
    '} from "../phenix-persistence/json-files.ts";\n'
    'import { isTerminalState } from "./workflow-reducer.ts";\n',
)
remove_between(
    workflow,
    "function sanitize(value: string): string {\n",
    "export function now(): string {\n  return new Date().toISOString();\n}\n",
)
replace_once(
    workflow,
    'export function now(): string {\n  return new Date().toISOString();\n}\n',
    'export const now = timestamp;\n',
)
replace_once(workflow, "sanitize(instanceId)", "sanitizePathSegment(instanceId)")
replace_once(workflow, "sanitize(actorId)", "sanitizePathSegment(actorId)")
remove_between(
    workflow,
    "function atomicWrite(target: string, data: unknown): void {\n",
    "export function readWorkflowRecord(\n",
)
replace_once(
    workflow,
    '''export function readWorkflowRecord(
  cwd: string,
  instanceId: string,
  actorId: string,
): WorkflowRuntimeRecord | undefined {
  try {
    return JSON.parse(
      fs.readFileSync(recordPath(cwd, instanceId, actorId), "utf-8"),
    ) as WorkflowRuntimeRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
''',
    '''function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode the stable workflow envelope before it enters reducer logic. */
export function decodeWorkflowRecord(value: unknown): WorkflowRuntimeRecord {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.instanceId !== "string" ||
    typeof value.actorId !== "string" ||
    typeof value.sessionId !== "string" ||
    value.definitionId !== "phenix-default" ||
    typeof value.definitionVersion !== "number" ||
    typeof value.state !== "string" ||
    typeof value.revision !== "number" ||
    !Array.isArray(value.active) ||
    !Array.isArray(value.completed) ||
    !isObject(value.facts) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new WorkflowStoreError(
      "INVALID_RECORD",
      "Persisted workflow record is malformed or uses an unsupported version.",
    );
  }

  return value as unknown as WorkflowRuntimeRecord;
}

export function readWorkflowRecord(
  cwd: string,
  instanceId: string,
  actorId: string,
): WorkflowRuntimeRecord | undefined {
  return readJsonFile(
    recordPath(cwd, instanceId, actorId),
    decodeWorkflowRecord,
  );
}
''',
)
replace_once(workflow, "atomicWrite(", "atomicWriteJson(")
# Replace every remaining call after the first replacement.
workflow_path = ROOT / workflow
workflow_content = workflow_path.read_text().replace("atomicWrite(", "atomicWriteJson(")
workflow_path.write_text(workflow_content)
remove_between(
    workflow,
    "export function writeWorkflowRecord(\n",
    "export function mutateWorkflowRecord(\n",
)
replace_once(
    workflow,
    '''      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
''',
    '''      if (!isErrno(error, "EEXIST")) throw error;
''',
)

# Remove the obsolete public overwrite surface and unused test import.
replace_once(
    "modules/phenix-pi/extensions/phenix-workflow/index.ts",
    "  writeWorkflowRecord,\n",
    "",
)
replace_once(
    "modules/phenix-pi/tests/workflow-store.test.ts",
    "  writeWorkflowRecord,\n",
    "",
)
