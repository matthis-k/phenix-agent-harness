from pathlib import Path
import re

root = Path("modules/phenix-pi")


def target(relative: str) -> Path:
    return root / relative


def read(relative: str) -> str:
    return target(relative).read_text()


def write(relative: str, content: str) -> None:
    target(relative).write_text(content)


def replace(relative: str, old: str, new: str, expected: int) -> None:
    content = read(relative)
    actual = content.count(old)
    if actual != expected:
        raise RuntimeError(
            f"{relative}: expected {expected} occurrences of {old!r}, found {actual}",
        )
    write(relative, content.replace(old, new))


def substitute(
    relative: str,
    pattern: str,
    replacement: str,
    expected: int,
    *,
    flags: int = 0,
) -> None:
    content = read(relative)
    updated, actual = re.subn(pattern, replacement, content, flags=flags)
    if actual != expected:
        raise RuntimeError(
            f"{relative}: expected {expected} matches for {pattern!r}, found {actual}",
        )
    write(relative, updated)


# There is one current source shape. Git history is the version history.
target("extensions/phenix-kernel/api-version.ts").unlink()

for relative in [
    "extensions/phenix-subagents/contract.ts",
    "extensions/phenix-subagents/contract-codec.ts",
    "extensions/phenix-subagents/contract-store.ts",
    "extensions/phenix-subagents/delegation-policy.ts",
    "extensions/phenix-subagents/handle-store.ts",
    "extensions/phenix-subagents/handle-types.ts",
    "extensions/phenix-subagents/tool-policy.ts",
    "extensions/phenix-subagents/workflow-delegator.ts",
    "extensions/phenix-workflow/workflow-definitions.ts",
    "extensions/phenix-workflow/workflow-store.ts",
    "extensions/phenix-workflow/workflow-types.ts",
]:
    substitute(
        relative,
        r'^import \{ PHENIX_API_VERSION \} from "\.\./phenix-kernel/api-version\.ts";\n',
        "",
        1,
        flags=re.MULTILINE,
    )

# Contract artifacts and result records are defined only by their current fields.
relative = "extensions/phenix-subagents/contract.ts"
substitute(
    relative,
    r"^\s*readonly definitionVersion: typeof PHENIX_API_VERSION;\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*readonly schemaVersion: typeof PHENIX_API_VERSION;\n",
    "",
    5,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*schemaVersion: PHENIX_API_VERSION,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*presetRevision: PHENIX_API_VERSION,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*definitionVersion: input\.runtime\.workflow\.definitionVersion,\n",
    "",
    1,
    flags=re.MULTILINE,
)

relative = "extensions/phenix-subagents/contract-codec.ts"
substitute(
    relative,
    r"\n\s*if \(raw\.presetRevision !== PHENIX_API_VERSION\) \{\n"
    r"\s*throw new Error\(`\$\{ctx\}: unsupported runtime\.tools\.presetRevision`\);\n"
    r"\s*\}\n",
    "\n",
    1,
)
substitute(
    relative,
    r"\n\s*if \(raw\.presetRevision !== PHENIX_API_VERSION\) \{\n"
    r"\s*throw new Error\(`\$\{ctx\}: unsupported runtime\.delegation\.roles\.presetRevision`\);\n"
    r"\s*\}\n",
    "\n",
    1,
)
substitute(
    relative,
    r"\n\s*if \(raw\.definitionVersion !== PHENIX_API_VERSION\) \{\n"
    r"\s*throw new Error\(`\$\{ctx\}: unsupported workflow definitionVersion`\);\n"
    r"\s*\}\n",
    "\n",
    1,
)
substitute(
    relative,
    r"\n\s*// ── schemaVersion .*?\n"
    r"\s*if \(value\.schemaVersion !== PHENIX_API_VERSION\) \{.*?\n\s*\}\n",
    "\n",
    1,
    flags=re.DOTALL,
)

relative = "extensions/phenix-subagents/contract-store.ts"
substitute(
    relative,
    r"^\s*value\.schemaVersion !== PHENIX_API_VERSION \|\|\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*schemaVersion: PHENIX_API_VERSION,\n",
    "",
    5,
    flags=re.MULTILINE,
)

# Resolved policy objects are current projections, not revisioned envelopes.
for relative in [
    "extensions/phenix-subagents/tool-policy.ts",
    "extensions/phenix-subagents/delegation-policy.ts",
]:
    substitute(
        relative,
        r"^\s*readonly presetRevision: typeof PHENIX_API_VERSION;\n",
        "",
        1,
        flags=re.MULTILINE,
    )
    substitute(
        relative,
        r"^\s*presetRevision: PHENIX_API_VERSION,\n",
        "",
        1,
        flags=re.MULTILINE,
    )

# Handles are validated by their current structure alone.
substitute(
    "extensions/phenix-subagents/handle-types.ts",
    r"^\s*readonly version: typeof PHENIX_API_VERSION;\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-subagents/handle-store.ts",
    r"^\s*value\.version !== PHENIX_API_VERSION \|\|\n",
    "",
    1,
    flags=re.MULTILINE,
)
replace(
    "extensions/phenix-subagents/handle-store.ts",
    "Persisted handle record is malformed or uses an unsupported version.",
    "Persisted handle record is malformed.",
    1,
)
substitute(
    "extensions/phenix-subagents/workflow-delegator.ts",
    r"^\s*version: PHENIX_API_VERSION,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-subagents/workflow-delegator.ts",
    r"^\s*definitionVersion: PHENIX_API_VERSION,\n",
    "",
    2,
    flags=re.MULTILINE,
)

# Workflow definitions and runtime records are lockfile-compatible source shapes.
relative = "extensions/phenix-workflow/workflow-types.ts"
substitute(
    relative,
    r"^\s*readonly version: typeof PHENIX_API_VERSION;\n",
    "",
    2,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*readonly definitionVersion: typeof PHENIX_API_VERSION;\n",
    "",
    2,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*readonly presetRevision: typeof PHENIX_API_VERSION;\n",
    "",
    1,
    flags=re.MULTILINE,
)

relative = "extensions/phenix-workflow/workflow-store.ts"
substitute(
    relative,
    r"^\s*value\.version !== PHENIX_API_VERSION \|\|\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r'^\s*typeof value\.definitionVersion !== "number" \|\|\n',
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*version: PHENIX_API_VERSION,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    relative,
    r"^\s*definitionVersion: PHENIX_API_VERSION,\n",
    "",
    1,
    flags=re.MULTILINE,
)
replace(
    relative,
    "Persisted workflow record is malformed or uses an unsupported version.",
    "Persisted workflow record is malformed.",
    1,
)

substitute(
    "extensions/phenix-workflow/workflow-definitions.ts",
    r"^\s*version: PHENIX_API_VERSION,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-workflow/workflow-runtime.ts",
    r"^\s*presetRevision: 1,\n",
    "",
    1,
    flags=re.MULTILINE,
)

# Remove definition-version plumbing from child contracts and root initialization.
substitute(
    "extensions/phenix-subagents/child-spec.ts",
    r"^\s*readonly definitionVersion: 1;\n",
    "",
    2,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-subagents/child-spec.ts",
    r"^\s*definitionVersion: input\.workflow\.definitionVersion,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-subagents/producer-contract.ts",
    r"^\s*definitionVersion: input\.spec\.workflow\.definitionVersion,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-composition/root-workflow-integration.ts",
    r"^\s*definitionVersion: workflowRecord\.definitionVersion,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-workflow/session-registry.ts",
    r"^\s*readonly definitionVersion: 1;\n",
    "",
    1,
    flags=re.MULTILINE,
)

# Other Phenix-owned serialized projections are also unversioned.
substitute(
    "extensions/phenix-routing/types.ts",
    r"^\s*readonly version: 1;\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-workflow/agent-capabilities.ts",
    r"^\s*readonly version: 1;\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "extensions/phenix-workflow/agent-capabilities.ts",
    r"^\s*version: 1,\n",
    "",
    1,
    flags=re.MULTILINE,
)
substitute(
    "runtime/verify.mjs",
    r"^\s*version: 1,\n",
    "",
    1,
    flags=re.MULTILINE,
)
replace(
    "extensions/phenix-subagents/contract-projection.ts",
    "from a contract artifact (v4)",
    "from a contract artifact",
    1,
)

# Test fixtures follow the one current shape.
fixture_fields = [
    ("tests/managed-delegation-runtime.test.ts", "version: 5,", 1),
    ("tests/workflow-decision-context.test.ts", "version: 1,", 1),
    ("tests/workflow-decision-context.test.ts", "definitionVersion: 1,", 1),
    ("tests/workflow-decision-context.test.ts", "presetRevision: 1,", 2),
    ("tests/session-isolation.test.ts", "version: 1,", 1),
    ("tests/session-isolation.test.ts", "definitionVersion: 1,", 1),
    ("tests/execution-quality-service.test.ts", "presetRevision: 1,", 2),
    ("tests/execution-quality-service.test.ts", "definitionVersion: 1,", 1),
    ("tests/execution-quality-service.test.ts", "version: 5,", 1),
    ("tests/runtime-finalization.test.ts", "version: 5,", 1),
    ("tests/production-subagent-manager.test.ts", "version: 5,", 1),
    ("tests/contract-tool-isolation.test.ts", "presetRevision: 1,", 2),
    ("tests/contract-tool-isolation.test.ts", "definitionVersion: 1,", 1),
    ("tests/contract-store.test.ts", "presetRevision: 1 as const,", 3),
    ("tests/contract-store.test.ts", "definitionVersion: 1,", 1),
    ("tests/contract.test.ts", "presetRevision: 1 as const,", 3),
    ("tests/contract.test.ts", "definitionVersion: 1 as const,", 1),
]
for relative, field, expected in fixture_fields:
    substitute(
        relative,
        rf"^\s*{re.escape(field)}\n",
        "",
        expected,
        flags=re.MULTILINE,
    )

substitute(
    "tests/contract.test.ts",
    r"^\s*assert\.equal\(issued\.artifact\.schemaVersion, 1\);\n",
    "",
    1,
    flags=re.MULTILINE,
)

write(
    "tests/handle-schema.test.ts",
    '''import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeHandleRecord } from "../extensions/phenix-subagents/handle-store.ts";

function persistedHandle(): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    id: "schema-test",
    sessionId: "schema-session",
    modelSet: "mixed",
    assignment: {},
    producerSpec: {},
    producerCycles: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
  };
}

describe("persisted handle schema", () => {
  it("accepts the current backend-neutral shape", () => {
    assert.equal(decodeHandleRecord(persistedHandle()).id, "schema-test");
  });

  it("rejects malformed records", () => {
    assert.throws(() => decodeHandleRecord({ id: "incomplete" }), /malformed/);
  });
});
''',
)

relative = "tests/persistence-json-files.test.ts"
replace(
    relative,
    'atomicWriteJson(target, { version: 1, value: "stored" });',
    'atomicWriteJson(target, { marker: 1, value: "stored" });',
    1,
)
replace(relative, "record.version", "record.marker", 1)
replace(
    relative,
    'it("rejects unsupported handle envelopes before runtime use", () => {',
    'it("rejects malformed handle records before runtime use", () => {',
    1,
)
replace(
    relative,
    'assert.throws(() => decodeHandleRecord({ version: 3, id: "old" }), /unsupported version/);',
    'assert.throws(() => decodeHandleRecord({ id: "incomplete" }), /malformed/);',
    1,
)
replace(
    relative,
    '() => decodeWorkflowRecord({ version: 1 }),',
    '() => decodeWorkflowRecord({ instanceId: "incomplete" }),',
    1,
)

# Avoid formatting-only noise from removed imports.
for path in root.rglob("*"):
    if not path.is_file() or path.suffix not in {".ts", ".mjs"}:
        continue
    content = path.read_text()
    path.write_text(re.sub(r"\n{3,}", "\n\n", content))
