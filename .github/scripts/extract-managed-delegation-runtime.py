from pathlib import Path
import re

coordinator = Path("modules/phenix-pi/extensions/phenix-subagents/coordinator.ts")
text = coordinator.read_text()

text = text.replace(
'''import type { LiveChildRunRecord } from "../phenix-runtime/child-session-registry.ts";
import { getChildSessionRegistry } from "../phenix-runtime/child-session-registry.ts";
import { ChildRuntimeError, childRunId } from "../phenix-runtime/child-session-types.ts";
''',
'''import { childRunId } from "../phenix-runtime/child-session-types.ts";
''')
text = text.replace(
'''import {
  type SubagentCancellation,
  SubagentExecutionError,
  type SubagentHandle,
} from "../phenix-runtime/subagent-manager.ts";
import type { SubagentManagerFactory } from "../phenix-runtime/subagent-manager-factory.ts";
''',
'''import type { ManagedDelegationRuntime } from "./managed-delegation-runtime.ts";
''')

text = re.sub(
    r'\ninterface ManagedCompletion \{.*?\n\}\n\nfunction createHandle',
    '\nfunction createHandle',
    text,
    count=1,
    flags=re.S,
)
text = re.sub(
    r'\nfunction executionError\(.*?\n\}\n\nfunction cancellationFromSignal\(.*?\n\}\n',
    '\n',
    text,
    count=1,
    flags=re.S,
)

text = text.replace(
'''export interface AgentExecutionCoordinatorOptions {
  readonly managers: SubagentManagerFactory;
  readonly activeModelSet: string;
  readonly maximumDelegationDepth: number;
}

export class AgentExecutionCoordinator {
  private readonly managers: SubagentManagerFactory;
  private readonly activeModelSet: string;
  private readonly maximumDelegationDepth: number;

  constructor(options: AgentExecutionCoordinatorOptions) {
    this.managers = options.managers;
    this.activeModelSet = options.activeModelSet;
    this.maximumDelegationDepth = options.maximumDelegationDepth;
  }
''',
'''export interface AgentExecutionCoordinatorOptions {
  readonly delegationRuntime: ManagedDelegationRuntime;
  readonly activeModelSet: string;
  readonly maximumDelegationDepth: number;
}

export class AgentExecutionCoordinator {
  private readonly delegationRuntime: ManagedDelegationRuntime;
  private readonly activeModelSet: string;
  private readonly maximumDelegationDepth: number;

  constructor(options: AgentExecutionCoordinatorOptions) {
    this.delegationRuntime = options.delegationRuntime;
    this.activeModelSet = options.activeModelSet;
    this.maximumDelegationDepth = options.maximumDelegationDepth;
  }
''')

text = text.replace(
'''    let ownedHandle: SubagentHandle<unknown> | undefined;
    let cleanupOwnedScope: (() => void) | undefined;
    try {
''',
'''    try {
''')

start = text.index('      const runController = new AbortController();')
end_marker = '      return { ok: true, record: settled.record };\n'
end = text.index(end_marker, start) + len(end_marker)
replacement = '''      const execution = await this.delegationRuntime.execute({
        compiler: executionCompiler,
        request: {
          task: params.task,
          requirements,
          returns: { schema: outputSchema },
        },
        record,
        cwd: ctx.cwd,
        sessionId,
        mode: isBackground ? "background" : "await",
        signal,
        timeoutMs: producerSpec.timeoutMs,
        rootChildRunId: rootRunId,
        settle: finalizeOrRejectHandle,
      });

      if (!execution.ok) {
        return {
          ok: false,
          message: execution.error.message,
          details: {
            code: execution.error.code,
            handleId: execution.record.id,
            status: execution.record.status,
          },
        };
      }
      return { ok: true, record: execution.record };
'''
text = text[:start] + replacement + text[end:]

text = text.replace(
'''    } catch (error) {
      cleanupOwnedScope?.();
      if (ownedHandle) {
        try {
          await ownedHandle.cancel("delegation execution failed");
        } catch {
          // Best-effort managed cancellation.
        }
      }

      const failedRecord = readRecord(ctx.cwd, sessionId, handleId);
      if (failedRecord) {
        if (!isTerminalHandleStatus(failedRecord.status)) {
          const normalized = executionError(error);
          failedRecord.status = normalized.code === "ABORTED" ? "cancelled" : "failed";
          failedRecord.errors = [`${normalized.code}: ${normalized.message}`];
          writeRecord(ctx.cwd, failedRecord);
        }
        finalizeOrRejectHandle(failedRecord);
      } else {
        rejectStartedTransition();
      }

      const normalized = executionError(error);
      return {
        ok: false,
        message: `phenix_delegate: execution failed: ${normalized.message}`,
        details: {
          code: normalized.code,
          ...(failedRecord ? { handleId: failedRecord.id } : {}),
        },
      };
    }
  }
''',
'''    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedRecord = readRecord(ctx.cwd, sessionId, handleId);
      if (failedRecord) {
        if (!isTerminalHandleStatus(failedRecord.status)) {
          failedRecord.status = "failed";
          failedRecord.errors = [`DELEGATION_PREPARATION_FAILED: ${message}`];
          writeRecord(ctx.cwd, failedRecord);
        }
        finalizeOrRejectHandle(failedRecord);
      } else {
        rejectStartedTransition();
      }

      return {
        ok: false,
        message: `phenix_delegate: execution preparation failed: ${message}`,
        details: {
          code: "DELEGATION_PREPARATION_FAILED",
          ...(failedRecord ? { handleId: failedRecord.id } : {}),
        },
      };
    }
  }
''')

suffix_start = text.index('  private finalizePersistedHandle(')
new_suffix = '''  async poll(ctx: ExtensionContext, id: string): Promise<HandleRecord | undefined> {
    return this.delegationRuntime.poll({
      cwd: ctx.cwd,
      sessionId: effectiveSessionId(ctx),
      id,
    });
  }

  async awaitHandle(
    ctx: ExtensionContext,
    id: string,
    signal: AbortSignal,
  ): Promise<HandleRecord | undefined> {
    return this.delegationRuntime.awaitHandle(
      {
        cwd: ctx.cwd,
        sessionId: effectiveSessionId(ctx),
        id,
      },
      signal,
    );
  }

  async cancelHandle(
    ctx: ExtensionContext,
    id: string,
    reason: string,
  ): Promise<HandleRecord | undefined> {
    return this.delegationRuntime.cancelHandle(
      {
        cwd: ctx.cwd,
        sessionId: effectiveSessionId(ctx),
        id,
      },
      reason,
    );
  }
}
'''
text = text[:suffix_start] + new_suffix
coordinator.write_text(text)

composition = Path("modules/phenix-pi/extensions/phenix.ts")
text = composition.read_text()
text = text.replace(
'import { getChildSessionRegistry } from "./phenix-runtime/child-session-registry.ts";\n',
'import { createManagedSubagentRegistry } from "./phenix-runtime/managed-subagent-registry.ts";\n')
text = text.replace(
'import { AgentExecutionCoordinator } from "./phenix-subagents/coordinator.ts";\n',
'import { AgentExecutionCoordinator } from "./phenix-subagents/coordinator.ts";\nimport { createManagedDelegationRuntime } from "./phenix-subagents/managed-delegation-runtime.ts";\n')
text = text.replace(
'''function registerTuiProjection(pi: ExtensionAPI): void {
  pi.on("context", async (_event, ctx) => {
    try {
      const registry = getChildSessionRegistry();
      const activeCount = registry.list().length;
''',
'''function registerTuiProjection(
  pi: ExtensionAPI,
  delegationRuntime: ManagedDelegationRuntime,
): void {
  pi.on("context", async (_event, ctx) => {
    try {
      const activeCount = delegationRuntime.activeCount;
''')
text = text.replace(
'''function registerShutdown(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async () => {
    const registry = getChildSessionRegistry();
    await registry.shutdown("session shutdown");
  });
}
''',
'''function registerShutdown(pi: ExtensionAPI, delegationRuntime: ManagedDelegationRuntime): void {
  pi.on("session_shutdown", async () => {
    await delegationRuntime.shutdown("session shutdown");
  });
}
''')
text = text.replace(
'import { createManagedDelegationRuntime } from "./phenix-subagents/managed-delegation-runtime.ts";\n',
'import {\n  createManagedDelegationRuntime,\n  type ManagedDelegationRuntime,\n} from "./phenix-subagents/managed-delegation-runtime.ts";\n')
text = text.replace(
'''  const managers = createSessionSubagentManagerFactory({
    acceptance,
    sessions: sessionRuntime,
  });

  coordinator = new AgentExecutionCoordinator({
    managers,
''',
'''  const managers = createSessionSubagentManagerFactory({
    acceptance,
    sessions: sessionRuntime,
  });
  const managedRegistry = createManagedSubagentRegistry();
  const delegationRuntime = createManagedDelegationRuntime({
    managers,
    registry: managedRegistry,
  });

  coordinator = new AgentExecutionCoordinator({
    delegationRuntime,
''')
text = text.replace('  registerTuiProjection(pi);\n  registerShutdown(pi);\n', '  registerTuiProjection(pi, delegationRuntime);\n  registerShutdown(pi, delegationRuntime);\n')
composition.write_text(text)

architecture = Path("modules/phenix-pi/tests/architecture-boundaries.test.ts")
text = architecture.read_text()
text = text.replace(
'        "phenix-runtime/session-subagent-adapter.ts",\n',
'        "phenix-runtime/session-subagent-adapter.ts",\n        "phenix-runtime/managed-subagent-registry.ts",\n')
text = text.replace(
'''  it("keeps the coordinator independent from concrete session execution", () => {
    assertNoDependencies(selectedFiles("phenix-subagents/coordinator.ts"), [
      "../phenix-runtime/child-session-backend",
      "../phenix-runtime/sdk-child-session-backend",
      "../phenix-runtime/subagent-session-runtime",
      "../phenix-subagents/attempt-runner",
    ]);
  });
''',
'''  it("keeps the coordinator independent from managed execution mechanics", () => {
    assertNoDependencies(selectedFiles("phenix-subagents/coordinator.ts"), [
      "../phenix-runtime/child-session-backend",
      "../phenix-runtime/sdk-child-session-backend",
      "../phenix-runtime/subagent-session-runtime",
      "../phenix-runtime/subagent-manager",
      "../phenix-runtime/subagent-manager-factory",
      "../phenix-subagents/attempt-runner",
    ]);
  });
''')
architecture.write_text(text)
