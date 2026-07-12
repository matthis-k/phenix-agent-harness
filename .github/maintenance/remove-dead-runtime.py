from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    target = ROOT / path
    content = target.read_text()
    count = content.count(old)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} matches, found {count}: {old[:100]!r}")
    target.write_text(content.replace(old, new, expected))


replace(
    "modules/phenix-pi/extensions/phenix.ts",
    '    childSessionBackend: "sdk",\n',
    "",
)
replace(
    "modules/phenix-pi/extensions/phenix.ts",
    '    kind: defaultPhenixConfiguration.runtime.childSessionBackend,\n',
    "",
)

replace(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-types.ts",
    '''/**
 * How a child session is backed.
 *
 * - "sdk": an independently stateful Pi AgentSession in the current process.
 * - "rpc": a Pi session controlled through the public RpcClient.
 *
 * Do not use vague values like "in-process" or "external-process".
 * An SDK child is a real independent model context even though it shares
 * the Node process.
 */
export type ChildSessionBackendKind = "sdk" | "rpc";
''',
    '''/**
 * Supported child-session mechanism.
 *
 * An SDK child is a real independent model context even though it shares the
 * Node process. Add another value only when that backend can satisfy the same
 * contract-bound completion and nested-delegation semantics.
 */
export type ChildSessionBackendKind = "sdk";
''',
)
for code in [
    '  | "RPC_PROCESS_EXITED"\n',
    '  | "RPC_NESTED_DELEGATION_UNSUPPORTED"\n',
    '  | "RPC_CONTRACT_RUNTIME_UNAVAILABLE"\n',
    '  "RPC_PROCESS_EXITED",\n',
    '  "RPC_NESTED_DELEGATION_UNSUPPORTED",\n',
    '  "RPC_CONTRACT_RUNTIME_UNAVAILABLE",\n',
]:
    replace(
        "modules/phenix-pi/extensions/phenix-runtime/child-session-types.ts",
        code,
        "",
    )

handle_path = ROOT / "modules/phenix-pi/extensions/phenix-subagents/handle-store.ts"
handle = handle_path.read_text()
blocks = [
    '''export function findByRunId(_cwd: string, _runId: string | undefined): HandleRecord | undefined {
  // In the Pi-native architecture, run IDs are not stored on producer cycles.
  // Use findByChildRunId or findById instead.
  return undefined;
}

''',
    '''// ── Producer cycle helpers ───────────────────────────────────────────────────

export function latestProducerCycle(record: HandleRecord): ProducerCycleRecord {
  const cycle = record.producerCycles.at(-1);
  if (!cycle) throw new Error(`handle ${record.id} has no producer cycles`);
  return cycle;
}

export function recordChildSessions(
  record: HandleRecord,
  children: readonly {
    readonly agent?: string;
    readonly success?: boolean;
    readonly exitCode?: number | null;
    readonly sessionFile?: string;
    readonly transcriptPath?: string;
  }[],
): void {
  latestProducerCycle(record).childSessions = children.map((child, index) => ({
    role: child.agent ?? (index === 0 ? record.producerSpec.agent : record.criticSpec?.agent ?? `child-${index}`),
    status: child.success === false || (child.exitCode !== undefined && child.exitCode !== null && child.exitCode !== 0)
      ? "failed"
      : "completed",
    ...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
    ...(child.transcriptPath ? { transcriptPath: child.transcriptPath } : {}),
  }));
}

''',
    '''export function currentParentRecord(_cwd: string): HandleRecord | undefined {
  // In the Pi-native child-session architecture, parent run IDs are not
  // propagated through environment variables. The coordinator manages
  // child sessions directly and records their handles.
  return undefined;
}

''',
]
for block in blocks:
    count = handle.count(block)
    if count != 1:
        raise RuntimeError(f"handle-store: expected one block, found {count}: {block[:80]!r}")
    handle = handle.replace(block, "", 1)
handle = handle.replace(
    '  return currentParentRecord(ctx.cwd)?.sessionId ?? sessionId(ctx);\n',
    '  return sessionId(ctx);\n',
    1,
)
handle_path.write_text(handle)
