from pathlib import Path

coordinator = Path("modules/phenix-pi/extensions/phenix-subagents/coordinator.ts")
text = coordinator.read_text()

# Replace the execution lifecycle while the original markers still exist.
lifecycle_start = text.index("      const runController = new AbortController();")
lifecycle_end_marker = "      return { ok: true, record: settled.record };\n"
lifecycle_end = text.index(lifecycle_end_marker, lifecycle_start) + len(lifecycle_end_marker)
lifecycle = '''      const execution = await this.delegationRuntime.execute({
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
text = text[:lifecycle_start] + lifecycle + text[lifecycle_end:]

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

managed_completion_start = text.index("interface ManagedCompletion")
managed_completion_end = text.index("function createHandle", managed_completion_start)
text = text[:managed_completion_start] + text[managed_completion_end:]

helper_start = text.index("function executionError")
helper_end = text.index("export interface AgentExecutionCoordinatorOptions", helper_start)
text = text[:helper_start] + text[helper_end:]

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

catch_start = text.index("    } catch (error) {\n      cleanupOwnedScope?.();")
suffix_start = text.index("  private finalizePersistedHandle(", catch_start)
replacement_suffix = '''    } catch (error) {
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

  async poll(ctx: ExtensionContext, id: string): Promise<HandleRecord | undefined> {
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
text = text[:catch_start] + replacement_suffix
coordinator.write_text(text)

composition = Path("modules/phenix-pi/extensions/phenix.ts")
text = composition.read_text()
text = text.replace(
'import { getChildSessionRegistry } from "./phenix-runtime/child-session-registry.ts";\n',
'import { createManagedSubagentRegistry } from "./phenix-runtime/managed-subagent-registry.ts";\n')
text = text.replace(
'import { AgentExecutionCoordinator } from "./phenix-subagents/coordinator.ts";\n',
'''import { AgentExecutionCoordinator } from "./phenix-subagents/coordinator.ts";
import {
  createManagedDelegationRuntime,
  type ManagedDelegationRuntime,
} from "./phenix-subagents/managed-delegation-runtime.ts";
''')
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
'''  const managers = createSessionSubagentManagerFactory({
    sessions: sessionRuntime,
    acceptance,
  });

  coordinator = new AgentExecutionCoordinator({
    managers,
''',
'''  const managers = createSessionSubagentManagerFactory({
    sessions: sessionRuntime,
    acceptance,
  });
  const managedRegistry = createManagedSubagentRegistry();
  const delegationRuntime = createManagedDelegationRuntime({
    managers,
    registry: managedRegistry,
  });

  coordinator = new AgentExecutionCoordinator({
    delegationRuntime,
''')
text = text.replace(
'  registerTuiProjection(pi);\n  registerShutdown(pi);\n',
'  registerTuiProjection(pi, delegationRuntime);\n  registerShutdown(pi, delegationRuntime);\n')
composition.write_text(text)

architecture = Path("modules/phenix-pi/tests/architecture-boundaries.test.ts")
text = architecture.read_text()
text = text.replace(
'        "phenix-runtime/session-subagent-adapter.ts",\n',
'        "phenix-runtime/session-subagent-adapter.ts",\n        "phenix-runtime/managed-subagent-registry.ts",\n')
text = text.replace(
'''  it("keeps the coordinator on the managed subagent surface", () => {
    assertNoDependencies(selectedFiles("phenix-subagents/coordinator.ts"), [
      "../phenix-runtime/child-session-backend",
      "../phenix-runtime/sdk-child-session-backend",
      "../phenix-runtime/subagent-session-runtime",
      "./execution-quality-service",
      "./attempt-runner",
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
      "./execution-quality-service",
      "./attempt-runner",
    ]);
  });
''')
architecture.write_text(text)

for obsolete in [
    Path("modules/phenix-pi/extensions/phenix-runtime/child-session-registry.ts"),
    Path("modules/phenix-pi/tests/child-session-registry.test.ts"),
]:
    if obsolete.exists():
        obsolete.unlink()
