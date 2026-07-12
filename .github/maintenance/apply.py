from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:80]!r}")
    write(path, content.replace(old, new, 1))


write(
    "modules/phenix-pi/extensions/phenix-composition/runtime-policy.ts",
    '''/**
 * Default runtime policy shared by composition and workflow authority.
 *
 * This module is passive configuration data. Runtime mechanisms consume these
 * values but must not redefine them locally, otherwise projected authority can
 * disagree with the child-session coordinator.
 */

/** Maximum number of delegation edges from the root coordinator. */
export const DEFAULT_MAXIMUM_DELEGATION_DEPTH = 3;
''',
)

replace_once(
    "modules/phenix-pi/extensions/phenix.ts",
    'import { link } from "./phenix-composition/linker.ts";\n',
    'import { link } from "./phenix-composition/linker.ts";\nimport { DEFAULT_MAXIMUM_DELEGATION_DEPTH } from "./phenix-composition/runtime-policy.ts";\n',
)
replace_once(
    "modules/phenix-pi/extensions/phenix.ts",
    '    maximumDelegationDepth: 3,\n',
    '    maximumDelegationDepth: DEFAULT_MAXIMUM_DELEGATION_DEPTH,\n',
)

replace_once(
    "modules/phenix-pi/extensions/phenix-workflow/workflow-runtime.ts",
    'import { randomUUID } from "node:crypto";\n\n',
    'import { randomUUID } from "node:crypto";\n\nimport { DEFAULT_MAXIMUM_DELEGATION_DEPTH } from "../phenix-composition/runtime-policy.ts";\n',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-workflow/workflow-runtime.ts",
    'const ROOT_MAXIMUM_DELEGATION_DEPTH = 4;\n\n',
    '',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-workflow/workflow-runtime.ts",
    '    remainingDepth: ROOT_MAXIMUM_DELEGATION_DEPTH,\n',
    '    remainingDepth: DEFAULT_MAXIMUM_DELEGATION_DEPTH,\n',
)

replace_once(
    "modules/phenix-pi/extensions/phenix-subagents/handle-types.ts",
    'export const HANDLE_VERSION = 4;\nexport const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);\n',
    '''export const HANDLE_VERSION = 4;

/** Persisted lifecycle states for a delegated handle. */
export type HandleStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

/** States after which neither producer execution nor workflow settlement may restart. */
export const TERMINAL_STATES: ReadonlySet<HandleStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "orphaned",
]);

export function isTerminalHandleStatus(status: HandleStatus): boolean {
  return TERMINAL_STATES.has(status);
}
''',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-subagents/handle-types.ts",
    '  status: "starting" | "running" | "completed" | "failed" | "cancelled" | "orphaned";\n',
    '  status: HandleStatus;\n',
)

replace_once(
    "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts",
    '''import {
  finalizeHandleWorkflow,
  transitionAuthorityForChild,
} from "../phenix-workflow/workflow-runtime.ts";
''',
    '''import {
  finalizeHandleWorkflow,
  initialWorkflowStateForRole,
  transitionAuthorityForChild,
} from "../phenix-workflow/workflow-runtime.ts";
''',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts",
    '''import {
  CRITIC_OUTPUT_SCHEMA,
  HANDLE_VERSION,
} from "./handle-types.ts";
''',
    '''import {
  CRITIC_OUTPUT_SCHEMA,
  HANDLE_VERSION,
  isTerminalHandleStatus,
} from "./handle-types.ts";
''',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts",
    '''function initialStateForRole(role: AgentRole) {
  return role === null
    ? "classified"
    : role === "scout" ? "scouting"
    : role === "planner" ? "planning"
    : role === "architect" ? "designing"
    : role === "implementer" ? "implementing"
    : role === "tester" ? "testing"
    : role === "critic" ? "reviewing"
    : "finalizing";
}

''',
    '',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts",
    '    const childInitialState = initialStateForRole(role) as ResolvedWorkflowChildInput["initialState"];\n',
    '    const childInitialState = initialWorkflowStateForRole(role);\n',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts",
    '''          (result) => {
            finalizeOrRejectHandle(result.record as HandleRecord);
          },
          (error) => {
            const failedRecord =
              readRecord(ctx.cwd, sessionId, handleId) ?? record;
            failedRecord.status = "failed";
            failedRecord.errors = [
              error instanceof Error ? error.message : String(error),
            ];
            writeRecord(ctx.cwd, failedRecord);
            finalizeOrRejectHandle(failedRecord);
          },
''',
    '''          (result) => {
            const persisted = readRecord(ctx.cwd, sessionId, handleId);
            const settledRecord =
              persisted && isTerminalHandleStatus(persisted.status)
                ? persisted
                : (result.record as HandleRecord);
            finalizeOrRejectHandle(settledRecord);
          },
          (error) => {
            const failedRecord =
              readRecord(ctx.cwd, sessionId, handleId) ?? record;
            if (!isTerminalHandleStatus(failedRecord.status)) {
              failedRecord.status = "failed";
              failedRecord.errors = [
                error instanceof Error ? error.message : String(error),
              ];
              writeRecord(ctx.cwd, failedRecord);
            }
            finalizeOrRejectHandle(failedRecord);
          },
''',
)

coordinator_path = "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts"
coordinator = read(coordinator_path)
marker = "  // ── Background operations: poll, await, cancel ────────────────────────\n"
start = coordinator.index(marker)
end = coordinator.rfind("\n}")
if end <= start:
    raise RuntimeError("coordinator: failed to locate lifecycle method block")
new_block = '''  // ── Background handle lifecycle ───────────────────────────────────────

  private finalizePersistedHandle(ctx: ExtensionContext, record: HandleRecord): void {
    if (!record.workflowBinding) return;

    try {
      const finalized = finalizeHandleWorkflow({ cwd: ctx.cwd, handle: record });
      if (!finalized) {
        throw new Error(
          `Workflow finalization returned no record for terminal handle ${record.id}.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = `WORKFLOW_FINALIZATION_FAILED: ${message}`;
      if (!record.errors?.includes(diagnostic)) {
        record.errors = [...(record.errors ?? []), diagnostic];
        writeRecord(ctx.cwd, record);
      }
    }
  }

  private abortError(signal: AbortSignal, fallback: string): ChildRuntimeError {
    const reason = signal.reason;
    if (reason instanceof ChildRuntimeError) return reason;
    return new ChildRuntimeError(
      "ABORTED",
      reason instanceof Error
        ? reason.message
        : typeof reason === "string" && reason.length > 0
          ? reason
          : fallback,
    );
  }

  private async awaitLiveCompletion(
    completion: Promise<AttemptRunResult>,
    signal: AbortSignal,
  ): Promise<AttemptRunResult> {
    if (signal.aborted) {
      throw this.abortError(signal, "Waiting for delegated execution was cancelled.");
    }

    return new Promise<AttemptRunResult>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        cleanup();
        reject(
          this.abortError(signal, "Waiting for delegated execution was cancelled."),
        );
      };

      signal.addEventListener("abort", onAbort, { once: true });
      completion.then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private orphanHandle(ctx: ExtensionContext, record: HandleRecord): HandleRecord {
    if (!isTerminalHandleStatus(record.status)) {
      record.status = "orphaned";
      record.errors = [
        ...(record.errors ?? []),
        "ORPHANED_SESSION: no live child run exists for this persisted handle.",
      ];
      writeRecord(ctx.cwd, record);
      this.finalizePersistedHandle(ctx, record);
    }
    return record;
  }

  async poll(ctx: ExtensionContext, id: string): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record || isTerminalHandleStatus(record.status)) return record;
    if (!record.childRunId) return record;

    const live = getChildSessionRegistry().get(record.childRunId);
    return live ? record : this.orphanHandle(ctx, record);
  }

  async awaitHandle(
    ctx: ExtensionContext,
    id: string,
    signal: AbortSignal,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record || isTerminalHandleStatus(record.status)) return record;
    if (!record.childRunId) return record;

    const live = getChildSessionRegistry().get(record.childRunId);
    if (!live) return this.orphanHandle(ctx, record);

    // Cancelling the wait does not cancel the child. Explicit child cancellation
    // remains the responsibility of cancelHandle().
    const result = await this.awaitLiveCompletion(live.completion, signal);
    return result.record as HandleRecord;
  }

  async cancelHandle(
    ctx: ExtensionContext,
    id: string,
    reason: string,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record || isTerminalHandleStatus(record.status)) return record;

    // Persist the terminal state before aborting the live run. The background
    // completion observer checks persisted terminal state and therefore cannot
    // overwrite an explicit cancellation with a generic failure.
    record.status = "cancelled";
    record.errors = [...(record.errors ?? []), reason];
    writeRecord(ctx.cwd, record);

    if (record.childRunId) {
      const registry = getChildSessionRegistry();
      const live = registry.get(record.childRunId);
      if (live) {
        const cancellation = new ChildRuntimeError("ABORTED", reason);
        if (!live.controller.signal.aborted) {
          live.controller.abort(cancellation);
        }
        try {
          await live.run.abort(reason);
        } catch {
          // Provider abort is best-effort after the terminal state is persisted.
        }
        try {
          await live.run.dispose();
        } catch {
          // Disposal is best-effort; the registry entry is removed regardless.
        }
        registry.remove(record.childRunId);
      }
    }

    this.finalizePersistedHandle(ctx, record);
    return record;
  }
'''
write(coordinator_path, coordinator[:start] + new_block + coordinator[end:])

# Add focused regression tests to the existing finalization suite.
test_path = "modules/phenix-pi/tests/runtime-finalization.test.ts"
test = read(test_path)
replace = '''import { finalizeHandleWorkflow } from "../extensions/phenix-workflow/workflow-runtime.ts";
'''
replacement = '''import {
  finalizeHandleWorkflow,
  initialWorkflowStateForRole,
} from "../extensions/phenix-workflow/workflow-runtime.ts";
import { isTerminalHandleStatus } from "../extensions/phenix-subagents/handle-types.ts";
'''
if test.count(replace) != 1:
    raise RuntimeError("runtime-finalization test import changed unexpectedly")
test = test.replace(replace, replacement, 1)
append = '''

describe("canonical runtime lifecycle policy", () => {
  it("uses executing as the base child initial state", () => {
    assert.equal(initialWorkflowStateForRole(null), "executing");
  });

  it("recognizes every persisted terminal handle state", () => {
    for (const status of ["completed", "failed", "cancelled", "orphaned"] as const) {
      assert.equal(isTerminalHandleStatus(status), true);
    }
    assert.equal(isTerminalHandleStatus("running"), false);
  });

  it("rejects a cancelled handle and clears its active workflow transition", () => {
    const cwd = temporaryDirectory("phenix-workflow-cancelled");
    const params = {
      instanceId: "instance-cancelled",
      actorId: "actor-cancelled",
      sessionId: "session-cancelled",
      definitionId: "phenix-default" as const,
      difficulty: "D0" as const,
      taskProfile: {
        complexity: 0,
        uncertainty: 0,
        consequence: 0,
        breadth: 0,
        coupling: 0,
        novelty: 0,
      },
      actorRole: "coordinator" as const,
      capabilityArtifactHash: "0".repeat(64),
    };
    const workflow = createWorkflowRecord(cwd, params);
    const begun = beginTransition(cwd, workflow, {
      expectedRevision: workflow.revision,
      transitionId: "d0.execute-base" as never,
      handleId: "handle-cancelled",
    });
    const handle = {
      id: "handle-cancelled",
      sessionId: params.sessionId,
      status: "cancelled",
      workflowBinding: {
        instanceId: params.instanceId,
        actorId: params.actorId,
        transitionExecutionId: begun.executionId,
        transitionId: "d0.execute-base",
        sourceState: "classified",
        sourceRevision: 0,
        acceptedState: "completed",
        rejectedState: "failed",
      },
    } as never;

    const finalized = finalizeHandleWorkflow({ cwd, handle });
    assert.ok(finalized);
    assert.equal(finalized.state, "failed");
    assert.equal(finalized.active.length, 0);
    assert.equal(finalized.completed.at(-1)?.accepted, false);
  });
});
'''
write(test_path, test.rstrip() + append)
