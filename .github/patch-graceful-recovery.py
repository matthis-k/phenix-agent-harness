from __future__ import annotations

import re
from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, content: str) -> None:
    Path(path).write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    source = read(path)
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one occurrence, found {count}: {old[:120]!r}")
    write(path, source.replace(old, new))


def replace_regex(path: str, pattern: str, replacement: str, *, flags: int = 0) -> None:
    source = read(path)
    updated, count = re.subn(pattern, replacement, source, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex match, found {count}: {pattern[:120]!r}")
    write(path, updated)


# Domain failure reporting.
replace_once(
    "modules/phenix-pi/domain/shared.ts",
    '  | "backend_start_failed"\n  | "provider_failed"',
    '  | "backend_start_failed"\n  | "agent_reported_failure"\n  | "provider_failed"',
)
replace_once(
    "modules/phenix-pi/domain/shared.ts",
    "export interface Failure {\n",
    '''export type FailureCategory =
  | "blocked"
  | "deadlock"
  | "insufficient_permissions"
  | "resource_limit"
  | "invalid_task"
  | "external_failure"
  | "other";

export interface FailureLimitSuggestion {
  readonly timeoutMs?: number;
  readonly maxTurns?: number | null;
  readonly maxToolCalls?: number | null;
  readonly maxRepairAttempts?: number;
}

export interface FailureReport {
  readonly source: "agent" | "automatic";
  readonly category: FailureCategory;
  readonly summary: string;
  readonly retryable: boolean;
  readonly requestedTools?: readonly string[];
  readonly suggestedLimits?: FailureLimitSuggestion;
}

export interface Failure {
''',
)

# Tool-call limits are optional and omitted by bundled agents.
replace_once(
    "modules/phenix-pi/domain/definition/definition.ts",
    "  readonly maxToolCalls: number;",
    "  readonly maxToolCalls?: number;",
)
replace_once(
    "modules/phenix-pi/application/catalog.ts",
    '''  if (!Number.isInteger(definition.limits.maxToolCalls) || definition.limits.maxToolCalls < 1) {
    error("agent_tool_limit_invalid", `maxToolCalls must be a positive integer`);
  }''',
    '''  if (
    definition.limits.maxToolCalls !== undefined &&
    (!Number.isInteger(definition.limits.maxToolCalls) || definition.limits.maxToolCalls < 1)
  ) {
    error("agent_tool_limit_invalid", `maxToolCalls must be omitted or a positive integer`);
  }''',
)
agents_path = "modules/phenix-pi/definitions/agents/index.ts"
agents = read(agents_path)
agents, removed_limits = re.subn(r", maxToolCalls: \d+", "", agents)
if removed_limits < 1:
    raise SystemExit("No bundled maxToolCalls fields were removed")
write(agents_path, agents)

# Retry metadata and override types.
replace_once(
    "modules/phenix-pi/domain/run/model.ts",
    '''export interface WorkflowCausation {''',
    '''export interface RunRetryLimitOverrides {
  readonly timeoutMs?: number;
  readonly maxTurns?: number | null;
  readonly maxToolCalls?: number | null;
  readonly maxRepairAttempts?: number;
}

export interface RunRetryOptions {
  readonly wait?: "await" | "background";
  readonly addTools?: readonly string[];
  readonly limits?: RunRetryLimitOverrides;
}

export interface WorkflowCausation {''',
)
replace_once(
    "modules/phenix-pi/domain/run/model.ts",
    '''    readonly wait: "await" | "background";
    readonly causation?: WorkflowCausation;''',
    '''    readonly wait: "await" | "background";
    readonly causation?: WorkflowCausation;
    readonly retryOf?: RunId;''',
)

# Public facade retry operation.
replace_once(
    "modules/phenix-pi/application/interfaces.ts",
    '''  RunSnapshot,
  SessionAgentPreset,''',
    '''  RunRetryOptions,
  RunSnapshot,
  SessionAgentPreset,''',
)
replace_once(
    "modules/phenix-pi/application/interfaces.ts",
    '''  cancel(runId: RunId, reason: string): Promise<void>;
  reparent(runId: RunId, newParentId: RunId): Promise<void>;''',
    '''  cancel(runId: RunId, reason: string): Promise<void>;
  retry<O>(callerId: RunId, targetId: RunId, options?: RunRetryOptions): Promise<RunHandle<O>>;
  reparent(runId: RunId, newParentId: RunId): Promise<void>;''',
)

# Execution facade: linked retry, bounded overrides, and special retry authorization.
execution_path = "modules/phenix-pi/application/execution-facade.ts"
replace_once(
    execution_path,
    '''import type {
  AgentDefinition,
  AnyDefinition,
  CapabilitySet,
  WorkflowDefinition,
} from "../domain/definition/definition.ts";''',
    '''import {
  definitionRef,
  type AgentDefinition,
  type AnyDefinition,
  type CapabilitySet,
  type WorkflowDefinition,
} from "../domain/definition/definition.ts";''',
)
replace_once(
    execution_path,
    '''  type RootRunInput,
  type RunRecord,
  type RunSnapshot,
  type StartRun,''',
    '''  type RootRunInput,
  type RunLimits,
  type RunRecord,
  type RunRetryOptions,
  type RunSnapshot,
  type StartRun,''',
)
replace_once(
    execution_path,
    '''export interface InternalStartRun<I, O> extends StartRun<I, O> {
  readonly causation?: WorkflowCausation;
  readonly trustedWorkflowInvocation?: boolean;
}''',
    '''export interface InternalStartRun<I, O> extends StartRun<I, O> {
  readonly causation?: WorkflowCausation;
  readonly trustedWorkflowInvocation?: boolean;
  readonly retryOf?: RunId;
  readonly retryOverrides?: Omit<RunRetryOptions, "wait">;
}''',
)
replace_once(
    execution_path,
    '''  start<I, O>(request: StartRun<I, O>): Promise<RunHandle<O>> {
    return this.startInternal(request);
  }

  async startInternal<I, O>(request: InternalStartRun<I, O>): Promise<RunHandle<O>> {''',
    '''  start<I, O>(request: StartRun<I, O>): Promise<RunHandle<O>> {
    return this.startInternal(request);
  }

  async retry<O>(
    callerId: RunId,
    targetId: RunId,
    options: RunRetryOptions = {},
  ): Promise<RunHandle<O>> {
    const caller = this.store.projection.requireRun(callerId);
    const target = this.store.projection.requireRun(targetId);
    this.assertRetryAccessible(caller, target);
    const retryOverrides = normalizeRetryOverrides(target.kind, options);
    return this.startInternal<unknown, O>({
      parentId: caller.id,
      definition: definitionRef(target.definitionId),
      input: target.input,
      wait: options.wait ?? "await",
      retryOf: target.id,
      ...(retryOverrides ? { retryOverrides } : {}),
    });
  }

  async startInternal<I, O>(request: InternalStartRun<I, O>): Promise<RunHandle<O>> {''',
)
replace_once(
    execution_path,
    '''      request.wait,
      request.causation,
    );''',
    '''      request.wait,
      request.causation,
      request.retryOf,
      request.retryOverrides,
    );''',
)
replace_once(
    execution_path,
    '''  private authorize<I, O>(
    parent: RunRecord,
    definition: AnyDefinition,
    request: InternalStartRun<I, O>,
  ): Partial<CapabilitySet> | undefined {
    let capabilities = parent.compiled.capabilities;''',
    '''  private authorize<I, O>(
    parent: RunRecord,
    definition: AnyDefinition,
    request: InternalStartRun<I, O>,
  ): Partial<CapabilitySet> | undefined {
    if (request.retryOf) {
      const original = this.store.projection.requireRun(request.retryOf);
      this.assertRetryAccessible(parent, original);
      if (original.definitionId !== definition.id) {
        throw new Error(`Retry definition ${definition.id} does not match ${original.definitionId}`);
      }
      return undefined;
    }
    let capabilities = parent.compiled.capabilities;''',
)
replace_once(
    execution_path,
    '''  private depth(runId: RunId): number {''',
    '''  private assertRetryAccessible(caller: RunRecord, target: RunRecord): void {
    if (target.kind === "root") throw new Error(`The root run cannot be retried`);
    if (this.store.projection.rootOf(caller.id) !== this.store.projection.rootOf(target.id)) {
      throw new Error(`Run ${target.id} is outside caller ${caller.id}'s root scope`);
    }
    if (!isTerminalRunState(target.state) || !target.outcome || target.outcome.status === "success") {
      throw new Error(`Run ${target.id} is not a failed or cancelled terminal run`);
    }
    if (caller.kind === "root") return;
    let current = target;
    while (current.parentId) {
      if (current.parentId === caller.id) return;
      current = this.store.projection.requireRun(current.parentId);
    }
    throw new Error(`Run ${target.id} is outside caller ${caller.id}'s descendant scope`);
  }

  private depth(runId: RunId): number {''',
)
replace_regex(
    execution_path,
    r'''  private compile\(\n    definition: AnyDefinition,\n    input: unknown,\n    capabilities: CapabilitySet,\n    wait: "await" \| "background",\n    causation\?: WorkflowCausation,\n  \): CompiledRunSpec \{.*?\n  \}\n\n  private resolveModel''',
    '''  private compile(
    definition: AnyDefinition,
    input: unknown,
    capabilities: CapabilitySet,
    wait: "await" | "background",
    causation?: WorkflowCausation,
    retryOf?: RunId,
    retryOverrides?: Omit<RunRetryOptions, "wait">,
  ): CompiledRunSpec {
    const invocation = {
      wait,
      ...(causation ? { causation } : {}),
      ...(retryOf ? { retryOf } : {}),
    };
    if (definition.kind === "agent") {
      return {
        definitionId: definition.id,
        input,
        outputSchemaId: definition.output.id,
        tools: applyRetryTools(definition.tools.allow, retryOverrides?.addTools),
        contextPolicy: definition.context,
        modelSelector: definition.model,
        limits: applyRetryLimits(definition.limits, retryOverrides?.limits),
        capabilities,
        invocation,
      };
    }
    return {
      definitionId: definition.id,
      input,
      outputSchemaId: definition.output.id,
      tools: [],
      limits: definition.limits,
      capabilities,
      invocation,
    };
  }

  private resolveModel''',
    flags=re.DOTALL,
)
replace_once(
    execution_path,
    '''function isTerminalEvent(type: string): boolean {''',
    '''const RECOVERY_ADDITIONAL_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

function normalizeRetryOverrides(
  kind: RunRecord["kind"],
  options: RunRetryOptions,
): Omit<RunRetryOptions, "wait"> | undefined {
  const addTools = [...new Set(options.addTools ?? [])];
  if (kind !== "agent" && addTools.length > 0) {
    throw new Error(`Only agent retries may add tools`);
  }
  for (const tool of addTools) {
    if (!RECOVERY_ADDITIONAL_TOOLS.has(tool)) {
      throw new Error(`Recovery retry may not grant tool ${tool}`);
    }
  }
  const limits = options.limits ? validateRetryLimits(options.limits) : undefined;
  if (addTools.length === 0 && !limits) return undefined;
  return {
    ...(addTools.length > 0 ? { addTools } : {}),
    ...(limits ? { limits } : {}),
  };
}

function validateRetryLimits(
  limits: NonNullable<RunRetryOptions["limits"]>,
): NonNullable<RunRetryOptions["limits"]> {
  if (limits.timeoutMs !== undefined) boundedInteger("timeoutMs", limits.timeoutMs, 1, 3_600_000);
  if (limits.maxTurns !== undefined && limits.maxTurns !== null) {
    boundedInteger("maxTurns", limits.maxTurns, 1, 200);
  }
  if (limits.maxToolCalls !== undefined && limits.maxToolCalls !== null) {
    boundedInteger("maxToolCalls", limits.maxToolCalls, 1, 1_000);
  }
  if (limits.maxRepairAttempts !== undefined) {
    boundedInteger("maxRepairAttempts", limits.maxRepairAttempts, 0, 10);
  }
  return limits;
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function applyRetryTools(base: readonly string[], additions: readonly string[] = []): readonly string[] {
  return [...new Set([...base, ...additions])];
}

function applyRetryLimits(
  base: RunLimits,
  override?: NonNullable<RunRetryOptions["limits"]>,
): RunLimits {
  if (!override) return base;
  const maxTurns = override.maxTurns === null ? undefined : (override.maxTurns ?? base.maxTurns);
  const maxToolCalls =
    override.maxToolCalls === null ? undefined : (override.maxToolCalls ?? base.maxToolCalls);
  const maxRepairAttempts = override.maxRepairAttempts ?? base.maxRepairAttempts;
  return {
    timeoutMs: override.timeoutMs ?? base.timeoutMs,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(maxRepairAttempts !== undefined ? { maxRepairAttempts } : {}),
    ...(base.maxNodeRuns !== undefined ? { maxNodeRuns: base.maxNodeRuns } : {}),
    ...(base.maxParallelism !== undefined ? { maxParallelism: base.maxParallelism } : {}),
  };
}

function isTerminalEvent(type: string): boolean {''',
)

# Agent handle retry action.
agent_tools_path = "modules/phenix-pi/application/agent-tools.ts"
replace_regex(
    agent_tools_path,
    r'''const handleParameters = defineSchema<\{.*?\n\);\n\nconst taskParameters''',
    '''const handleParameters = defineSchema<{
  action: "inspect" | "await" | "send" | "cancel" | "retry";
  runId: string;
  message?: string;
  wait?: "await" | "background";
  addTools?: string[];
  limits?: {
    timeoutMs?: number;
    maxTurns?: number | null;
    maxToolCalls?: number | null;
    maxRepairAttempts?: number;
  };
}>(
  "tool.phenix-handle",
  Type.Object({
    action: Type.Enum(["inspect", "await", "send", "cancel", "retry"]),
    runId: Type.String(),
    message: Type.Optional(Type.String()),
    wait: Type.Optional(Type.Enum(["await", "background"])),
    addTools: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
    limits: Type.Optional(
      Type.Object({
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
        maxTurns: Type.Optional(
          Type.Union([Type.Integer({ minimum: 1, maximum: 200 }), Type.Null()]),
        ),
        maxToolCalls: Type.Optional(
          Type.Union([Type.Integer({ minimum: 1, maximum: 1_000 }), Type.Null()]),
        ),
        maxRepairAttempts: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      }),
    ),
  }),
);

const taskParameters''',
    flags=re.DOTALL,
)
replace_once(
    agent_tools_path,
    '''      description:
        "Inspect, await, send a message to, or cancel an accessible run. Cancelling an await only cancels the wait, never the child.",''',
    '''      description:
        "Inspect, await, message, cancel, or retry an accessible run. Retry creates a linked replacement run and may add only bounded non-mutating recovery permissions.",''',
)
replace_once(
    agent_tools_path,
    '''        if (params.action === "await") {
          const outcome = await this.execution.await(targetId, signal);
          return { text: JSON.stringify(outcome), details: outcome };
        }
        const caller = this.store.projection.requireRun(parentId);''',
    '''        if (params.action === "await") {
          const outcome = await this.execution.await(targetId, signal);
          return { text: JSON.stringify(outcome), details: outcome };
        }
        if (params.action === "retry") {
          const wait = params.wait ?? "await";
          const handle = await this.execution.retry(parentId, targetId, {
            wait,
            ...(params.addTools ? { addTools: params.addTools } : {}),
            ...(params.limits ? { limits: params.limits } : {}),
          });
          if (wait === "background") {
            const details = { runId: handle.id, retryOf: targetId, status: "running" };
            return { text: JSON.stringify(details), details };
          }
          const outcome = await handle.result(signal);
          const details = { runId: handle.id, retryOf: targetId, outcome };
          return { text: JSON.stringify(details), details };
        }
        const caller = this.store.projection.requireRun(parentId);''',
)

# Agent executor: canonical phenix_fail and compiled retry settings.
executor_path = "modules/phenix-pi/application/agent-executor.ts"
replace_once(executor_path, 'import type { AgentDefinition, AnyDefinition }', 'import { Type } from "typebox";\n\nimport type { AgentDefinition, AnyDefinition }')
replace_once(
    executor_path,
    'import type { RunRecord } from "../domain/run/model.ts";\nimport type { RunId } from "../domain/shared.ts";',
    '''import type { RunLimits, RunRecord } from "../domain/run/model.ts";
import type {
  Failure,
  FailureCategory,
  FailureLimitSuggestion,
  FailureReport,
  RunId,
} from "../domain/shared.ts";''',
)
replace_once(
    executor_path,
    '''interface LiveAgent {
  readonly session: AgentSessionPort;
  readonly definition: AgentDefinition<unknown, unknown>;
  unsubscribe: () => void;''',
    '''interface LiveAgent {
  readonly session: AgentSessionPort;
  readonly definition: AgentDefinition<unknown, unknown>;
  readonly limits: RunLimits;
  unsubscribe: () => void;''',
)
replace_once(
    executor_path,
    '''export class AgentExecutor implements RunImplementation {''',
    '''interface AgentFailureInput {
  readonly summary: string;
  readonly category?: FailureCategory;
  readonly retryable?: boolean;
  readonly requestedTools?: readonly string[];
  readonly suggestedLimits?: FailureLimitSuggestion;
}

const agentFailureSchema = defineSchema<AgentFailureInput>(
  "agent.failure-report",
  Type.Object({
    summary: Type.String({ minLength: 1, maxLength: 2_000 }),
    category: Type.Optional(
      Type.Enum([
        "blocked",
        "deadlock",
        "insufficient_permissions",
        "resource_limit",
        "invalid_task",
        "external_failure",
        "other",
      ]),
    ),
    retryable: Type.Optional(Type.Boolean()),
    requestedTools: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 8 }),
    ),
    suggestedLimits: Type.Optional(
      Type.Object({
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
        maxTurns: Type.Optional(
          Type.Union([Type.Integer({ minimum: 1, maximum: 200 }), Type.Null()]),
        ),
        maxToolCalls: Type.Optional(
          Type.Union([Type.Integer({ minimum: 1, maximum: 1_000 }), Type.Null()]),
        ),
        maxRepairAttempts: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
      }),
    ),
  }),
);

export class AgentExecutor implements RunImplementation {''',
)
replace_once(
    executor_path,
    '''    const customTools = await this.buildTools(command.runId, definition);
    if (!this.isActive(command.runId)) return;
    const spec: CreateAgentSessionSpec = {''',
    '''    const compiled = this.store.projection.requireRun(command.runId).compiled;
    const customTools = await this.buildTools(command.runId, definition, compiled.tools);
    if (!this.isActive(command.runId)) return;
    const spec: CreateAgentSessionSpec = {''',
)
replace_once(
    executor_path,
    '''      tools: [...new Set([...definition.tools.allow, "phenix_return"])],''',
    '''      tools: [...new Set([...compiled.tools, "phenix_return", "phenix_fail"])],''',
)
replace_once(
    executor_path,
    '''    const live = this.attach(command.runId, definition, session);''',
    '''    const live = this.attach(command.runId, definition, compiled.limits, session);''',
)
replace_once(
    executor_path,
    '''    const customTools = await this.buildTools(command.runId, definition);
    const spec: CreateAgentSessionSpec = {''',
    '''    const compiled = this.store.projection.requireRun(command.runId).compiled;
    const customTools = await this.buildTools(command.runId, definition, compiled.tools);
    const spec: CreateAgentSessionSpec = {''',
)
# second tools occurrence
source = read(executor_path)
old = '      tools: [...new Set([...definition.tools.allow, "phenix_return"])],'
if source.count(old) != 1:
    raise SystemExit(f"{executor_path}: expected one remaining recover tools occurrence")
write(executor_path, source.replace(old, '      tools: [...new Set([...compiled.tools, "phenix_return", "phenix_fail"])],'))
# second attach occurrence
source = read(executor_path)
old = '    const live = this.attach(command.runId, definition, session);'
if source.count(old) != 1:
    raise SystemExit(f"{executor_path}: expected one remaining recover attach occurrence")
write(executor_path, source.replace(old, '    const live = this.attach(command.runId, definition, compiled.limits, session);'))
replace_once(
    executor_path,
    '''      previousCycle?.state === "idle" &&
      previousCycle.number > definition.limits.maxRepairAttempts
    ) {''',
    '''      previousCycle?.state === "idle" &&
      previousCycle.number > (compiled.limits.maxRepairAttempts ?? 0)
    ) {''',
)
replace_once(
    executor_path,
    '''    definition: AgentDefinition<unknown, unknown>,
    session: AgentSessionPort,
  ): LiveAgent {
    const live: LiveAgent = {
      session,
      definition,''',
    '''    definition: AgentDefinition<unknown, unknown>,
    limits: RunLimits,
    session: AgentSessionPort,
  ): LiveAgent {
    const live: LiveAgent = {
      session,
      definition,
      limits,''',
)
replace_regex(
    executor_path,
    r'''  private async buildTools\(.*?\n  \}\n\n  private async observe''',
    '''  private async buildTools(
    runId: RunId,
    definition: AgentDefinition<unknown, unknown>,
    allowedTools: readonly string[],
  ): Promise<readonly AgentTool[]> {
    const childTools = await this.tools.forRun(runId);
    const completionSchema = defineSchema<unknown>(
      `${definition.output.id}.completion`,
      definition.output.jsonSchema,
    );
    const completion: AgentTool = {
      name: "phenix_return",
      label: "Phenix Return",
      description:
        "Submit this run's final typed outcome. Use exactly once as the final action; ordinary text does not complete the run.",
      parameters: completionSchema,
      execute: async (value) =>
        this.serial.run(runId, async () => {
          const validation = definition.output.validate(value);
          if (!validation.ok) {
            await this.controller.rejectOutput(runId, validation.issues);
            throw new Error(
              `Output rejected: ${validation.issues
                .map((issue) => `${issue.path} ${issue.message}`)
                .join("; ")}`,
            );
          }
          await this.controller.submitOutput(runId, validation.value);
          return {
            text: "Result accepted.",
            details: { runId },
            terminate: true,
          };
        }),
    };
    const failureTool: AgentTool = {
      name: "phenix_fail",
      label: "Phenix Fail",
      description:
        "Stop this run gracefully with a short structured report when blocked, deadlocked, under-permissioned, or otherwise unable to produce a valid result.",
      parameters: agentFailureSchema,
      execute: async (value) =>
        this.serial.run(runId, async () => {
          const validation = agentFailureSchema.validate(value);
          if (!validation.ok) {
            throw new Error(
              validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "),
            );
          }
          const report: FailureReport = {
            source: "agent",
            category: validation.value.category ?? "other",
            summary: validation.value.summary,
            retryable: validation.value.retryable ?? true,
            ...(validation.value.requestedTools
              ? { requestedTools: validation.value.requestedTools }
              : {}),
            ...(validation.value.suggestedLimits
              ? { suggestedLimits: validation.value.suggestedLimits }
              : {}),
          };
          const failure: Failure = {
            code: "agent_reported_failure",
            message: report.summary,
            retryable: report.retryable,
            details: report,
          };
          await this.controller.fail(runId, failure);
          return {
            text: "Failure report accepted.",
            details: { runId, failure },
            terminate: true,
          };
        }),
    };
    const allowed = new Set(allowedTools);
    return [completion, failureTool, ...childTools.filter((tool) => allowed.has(tool.name))];
  }

  private async observe''',
    flags=re.DOTALL,
)
replace_once(
    executor_path,
    '''        await this.controller.fail(runId, {
          code: "turn_budget_exceeded",
          message: `Agent exceeded ${maxTurns} turns`,
          retryable: false,
        });''',
    '''        await this.controller.fail(
          runId,
          automaticFailure(
            "turn_budget_exceeded",
            `Agent exceeded ${maxTurns} turns`,
            "resource_limit",
            true,
            { maxTurns: Math.max(maxTurns * 2, turns + 4) },
          ),
        );''',
)
replace_once(
    executor_path,
    '''      const toolCalls = await this.controller.toolStarted(runId, event.toolName);
      if (toolCalls > live.definition.limits.maxToolCalls) {
        await this.controller.fail(runId, {
          code: "tool_budget_exceeded",
          message: `Agent exceeded ${live.definition.limits.maxToolCalls} tool calls`,
          retryable: false,
        });
      }''',
    '''      const toolCalls = await this.controller.toolStarted(runId, event.toolName);
      const maxToolCalls = live.limits.maxToolCalls;
      if (maxToolCalls !== undefined && toolCalls > maxToolCalls) {
        await this.controller.fail(
          runId,
          automaticFailure(
            "tool_budget_exceeded",
            `Agent exceeded ${maxToolCalls} tool calls`,
            "resource_limit",
            true,
            { maxToolCalls: Math.max(maxToolCalls * 2, toolCalls + 10) },
          ),
        );
      }''',
)
replace_once(
    executor_path,
    '''      await this.controller.fail(runId, {
        code: "provider_failed",
        message: event.message,
        retryable: event.retryable,
      });''',
    '''      await this.controller.fail(
        runId,
        automaticFailure(
          "provider_failed",
          event.message,
          "external_failure",
          event.retryable,
        ),
      );''',
)
replace_once(
    executor_path,
    '''    if (settledCycle > live.definition.limits.maxRepairAttempts) {
      await this.controller.fail(runId, {
        code: "output_missing",
        message: `Agent settled without phenix_return after ${settledCycle} cycle(s)`,
        retryable: false,
      });''',
    '''    const maxRepairAttempts = live.limits.maxRepairAttempts ?? 0;
    if (settledCycle > maxRepairAttempts) {
      await this.controller.fail(
        runId,
        automaticFailure(
          "output_missing",
          `Agent settled without phenix_return or phenix_fail after ${settledCycle} cycle(s)`,
          "deadlock",
          true,
          { maxRepairAttempts: Math.min(10, maxRepairAttempts + 1) },
        ),
      );''',
)
replace_once(
    executor_path,
    '''        "The run is not complete: submit the required typed result with phenix_return. Do not only describe it in text.",''',
    '''        "The run is not complete: call phenix_return with the typed result, or phenix_fail with a short structured report if blocked or deadlocked.",''',
)
replace_once(
    executor_path,
    '''    await this.controller.fail(runId, {
      code: "provider_failed",
      message: `Agent session observation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      retryable: false,
    });''',
    '''    await this.controller.fail(
      runId,
      automaticFailure(
        "provider_failed",
        `Agent session observation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "external_failure",
        true,
      ),
    );''',
)
replace_once(
    executor_path,
    '''    if (live.definition.limits.timeoutMs <= 0) return;''',
    '''    if (live.limits.timeoutMs <= 0) return;''',
)
replace_once(
    executor_path,
    '''    const remaining = Math.max(0, live.definition.limits.timeoutMs - elapsed);''',
    '''    const remaining = Math.max(0, live.limits.timeoutMs - elapsed);''',
)
replace_once(
    executor_path,
    '''        .fail(runId, {
          code: "timeout",
          message: `Agent timed out after ${live.definition.limits.timeoutMs}ms`,
          retryable: false,
        })''',
    '''        .fail(
          runId,
          automaticFailure(
            "timeout",
            `Agent timed out after ${live.limits.timeoutMs}ms`,
            "resource_limit",
            true,
            { timeoutMs: Math.min(3_600_000, Math.max(live.limits.timeoutMs * 2, 60_000)) },
          ),
        )''',
)
replace_once(
    executor_path,
    '''    return `${definition.prompt.render(input)}\n\nExecution protocol:\n- You are run-scoped and own only the supplied task.\n- Use only the exact tools provided by this definition.\n- A settled Pi cycle is not completion.\n- Finish only by calling phenix_return with an output matching schema ${definition.output.id}.\n- Background children remain attached; resolve or cancel them before returning.`;''',
    '''    return `${definition.prompt.render(input)}\n\nExecution protocol:\n- You are run-scoped and own only the supplied task.\n- Use only the exact tools provided by this definition.\n- A settled Pi cycle is not completion.\n- Finish successfully only by calling phenix_return with an output matching schema ${definition.output.id}.\n- If blocked, deadlocked, missing permissions, or unable to produce a valid result, call phenix_fail with a short report instead of looping or inventing success.\n- When a child fails, inspect its report, surface it explicitly, and decide whether a bounded phenix_handle retry is appropriate.\n- Background children remain attached; resolve, retry, or cancel them before returning.`;''',
)
replace_once(
    executor_path,
    '''function requireAgent(definition: AnyDefinition): AgentDefinition<unknown, unknown> {''',
    '''function automaticFailure(
  code: Failure["code"],
  message: string,
  category: FailureCategory,
  retryable: boolean,
  suggestedLimits?: FailureLimitSuggestion,
): Failure {
  const report: FailureReport = {
    source: "automatic",
    category,
    summary: message,
    retryable,
    ...(suggestedLimits ? { suggestedLimits } : {}),
  };
  return { code, message, retryable, details: report };
}

function requireAgent(definition: AnyDefinition): AgentDefinition<unknown, unknown> {''',
)

# User and parent notifications for failures and retries.
runtime_path = "modules/phenix-pi/composition/create-phenix-runtime.ts"
replace_regex(
    runtime_path,
    r'''  const unsubscribeNotifications = events.subscribe\(async \(event\) => \{.*?\n  \}\);''',
    '''  const unsubscribeNotifications = events.subscribe(async (event) => {
    const run = store.projection.runs.get(event.runId);
    if (!run) return;
    const retryOf = run.compiled.invocation.retryOf;
    if (event.type === "run.created" && retryOf) {
      await rootNotifier?.(
        `Recovery run ${run.id} started for failed run ${retryOf}. The original outcome remains immutable.`,
      );
      return;
    }
    if (!isTerminalEvent(event.type) || !run.parentId) return;
    const parent = store.projection.runs.get(run.parentId);
    if (!parent) return;
    const summary = summarizeTerminal(run.outcome, run.id, retryOf);
    const failed = run.outcome?.status === "failure";
    if (failed || retryOf || (run.compiled.invocation.wait === "background" && parent.kind === "root")) {
      await rootNotifier?.(summary);
    }
    if (parent.kind === "agent" && !isTerminalRunState(parent.state)) {
      if (failed) {
        await execution.notify(
          parent.id,
          `${summary} Inspect the failure report, inform the user, and decide whether to retry with phenix_handle, choose a different route, ask for user input, or stop.`,
        );
      } else if (run.compiled.invocation.wait === "background") {
        await execution.notify(parent.id, summary);
      }
    }
  });''',
    flags=re.DOTALL,
)
replace_regex(
    runtime_path,
    r'''function summarizeTerminal\(outcome: unknown, runId: RunId\): string \{.*?\n\}''',
    '''function summarizeTerminal(outcome: unknown, runId: RunId, retryOf?: RunId): string {
  const value = outcome as
    | { readonly status: "success"; readonly value: unknown }
    | {
        readonly status: "failure";
        readonly failure: {
          readonly code: string;
          readonly message: string;
          readonly retryable: boolean;
          readonly causeRunId?: RunId;
        };
      }
    | { readonly status: "cancelled"; readonly reason: string }
    | undefined;
  const prefix = retryOf ? `Recovery run ${runId} for ${retryOf}` : `Run ${runId}`;
  if (!value) return `${prefix} reached a terminal state.`;
  if (value.status === "failure") {
    const cause = value.failure.causeRunId ? ` Cause: ${value.failure.causeRunId}.` : "";
    const recovery = value.failure.retryable
      ? " A bounded retry may be appropriate after inspecting the report."
      : " The failure is marked non-retryable; choose another route or ask the user before forcing recovery.";
    return `${prefix} failed [${value.failure.code}]: ${value.failure.message}.${cause}${recovery}`;
  }
  if (value.status === "cancelled") return `${prefix} was cancelled: ${value.reason}`;
  const summary =
    typeof value.value === "object" &&
    value.value !== null &&
    typeof (value.value as { summary?: unknown }).summary === "string"
      ? (value.value as { summary: string }).summary
      : "completed successfully";
  return `${prefix} completed: ${summary}. Use phenix_handle to inspect the full outcome.`;
}''',
    flags=re.DOTALL,
)

# Root prompt explicitly requires reporting and recovery decisions.
root_path = "modules/phenix-pi/extension/root-extension.ts"
replace_once(
    root_path,
    '''- Never reproduce an invariant workflow manually; phenix_dispatch is the only root execution entry point.\n- Available definitions:''',
    '''- Never reproduce an invariant workflow manually; phenix_dispatch is the only root execution entry point.
- When any descendant fails, inform the user immediately, inspect the structured failure and cause run, then decide whether to retry with phenix_handle, dispatch a better-suited workflow, request user input, or stop.
- Retry only with bounded settings and the minimum additional permissions needed; recovery may add read/search tools or bash, never mutation permissions to a read-only task.\n- Available definitions:''',
)

# Documentation.
docs_path = "docs/INTERFACES.md"
replace_once(
    docs_path,
    '''Agent success requires both an accepted schema-valid `phenix_return` value and a later `agent_settled` boundary.''',
    '''Agent success requires both an accepted schema-valid `phenix_return` value and a later `agent_settled` boundary. An agent that cannot make progress terminates explicitly through `phenix_fail`; automated runtime failures use the same structured report shape.''',
)
replace_once(
    docs_path,
    '''- `phenix_handle` inspects, awaits, messages, or cancels an accessible descendant without introducing another handle identity.''',
    '''- `phenix_handle` inspects, awaits, messages, cancels, or retries an accessible failed descendant. A retry is a linked new run; the failed run remains immutable evidence. Recovery overrides are bounded and may add only non-mutating repository tools plus `bash`.''',
)
replace_once(
    docs_path,
    '''- `phenix_return` exists only inside child agent sessions and submits the definition's output schema.''',
    '''- `phenix_return` exists only inside child agent sessions and submits the definition's output schema.
- `phenix_fail` exists only inside child agent sessions and records a short structured failure report for blockage, deadlock, missing permissions, resource exhaustion, or other inability to return valid output.''',
)

# Catalog tests: no bundled tool-call caps, while QA reviews also remain turn-unbounded.
replace_regex(
    "modules/phenix-pi/tests/catalog-validation.test.ts",
    r'''test\("QA analysis agents rely on timeout and tool-call bounds instead of fixed turns", \(\) => \{.*?\n\}\);''',
    '''test("bundled agents omit tool-call caps by default", () => {
  for (const definition of agentDefinitions) {
    assert.equal(definition.limits.maxToolCalls, undefined);
    assert.ok(definition.limits.timeoutMs > 0);
  }
});

test("open-ended QA analysis agents omit fixed turn caps", () => {
  const qaAgentIds = new Set(["agent.scout", "agent.tester", "agent.architect", "agent.critic"]);
  const qaAgents = agentDefinitions.filter((definition) => qaAgentIds.has(definition.id));
  assert.equal(qaAgents.length, qaAgentIds.size);
  for (const definition of qaAgents) assert.equal(definition.limits.maxTurns, undefined);
});''',
    flags=re.DOTALL,
)

# End-to-end graceful failure and retry test.
test_path = Path("modules/phenix-pi/tests/graceful-recovery.test.ts")
test_path.write_text('''import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRunLedger } from "../adapters/persistence/in-memory-run-ledger.ts";
import { AgentExecutor } from "../application/agent-executor.ts";
import { FacadeAgentToolFactory } from "../application/agent-tools.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { CatalogFacadeImpl } from "../application/catalog-facade.ts";
import { OrderedDomainEventBus } from "../application/domain-event-bus.ts";
import { ExecutionFacadeImpl } from "../application/execution-facade.ts";
import { ExecutionStore } from "../application/execution-store.ts";
import { TaskFacadeImpl } from "../application/task-facade.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { AGENT_SCOUT } from "../definitions/ids.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import type { FailureReport, RunId } from "../domain/shared.ts";
import type {
  AgentSessionBackend,
  AgentSessionObservation,
  AgentSessionPort,
  AgentSessionReference,
  AgentTool,
  CreateAgentSessionSpec,
} from "../ports/agent-session-backend.ts";
import type { IdGenerator } from "../ports/clock.ts";

class Ids implements IdGenerator {
  private value = 0;
  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

class FakeSession implements AgentSessionPort {
  readonly reference: AgentSessionReference;
  readonly listeners = new Set<(event: AgentSessionObservation) => void>();
  isStreaming = false;
  disposed = false;

  constructor(id: string) {
    this.reference = { sessionId: id };
  }

  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  async notify(): Promise<void> {}
  async abort(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  subscribe(listener: (event: AgentSessionObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: AgentSessionObservation): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeBackend implements AgentSessionBackend {
  readonly sessions: FakeSession[] = [];
  readonly specs: CreateAgentSessionSpec[] = [];

  async create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort> {
    const session = new FakeSession(`fake-${this.sessions.length + 1}`);
    this.sessions.push(session);
    this.specs.push(spec);
    return session;
  }
  async recover(): Promise<AgentSessionPort | undefined> {
    return undefined;
  }
  tool(index: number, name: string): AgentTool {
    const tool = this.specs[index]?.customTools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name} for session ${index}`);
    return tool;
  }
}

test("agent failure reports remain inspectable and can be retried with bounded overrides", async () => {
  const ids = new Ids();
  const events = new OrderedDomainEventBus();
  const store = new ExecutionStore({
    ledger: new InMemoryRunLedger(),
    events,
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
    ids,
  });
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions]) definitions.register(definition);
  definitions.seal(functions, {
    has: (operation) => operation === "local.noop" || operation === "local.qa-checks",
    async run(_operation, input) {
      return input;
    },
  });
  const execution = new ExecutionFacadeImpl({
    catalog: definitions,
    store,
    models: {
      async resolve(selector) {
        return {
          requested: selector,
          concrete: { kind: "concrete", provider: "test", model: "model" },
          thinking: "medium",
          policyRevision: "test",
        };
      },
    },
    ids,
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
    rootInvokableDefinitions: [AGENT_SCOUT],
  });
  const tasks = new TaskFacadeImpl({
    store,
    catalog: definitions,
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
    ids,
  });
  const catalog = new CatalogFacadeImpl(definitions, store);
  const backend = new FakeBackend();
  const agents = new AgentExecutor({
    backend,
    controller: execution,
    tools: new FacadeAgentToolFactory({ execution, tasks, catalog, store }),
    store,
    cwd: process.cwd(),
    clock: { now: () => "2026-01-01T00:00:00.000Z" },
  });
  execution.registerImplementation("agent", agents);
  execution.registerImplementation("workflow", {
    async start() {
      throw new Error("not used");
    },
  });
  execution.seal();

  const root = "root-graceful-recovery" as RunId;
  await execution.initializeRoot({ id: root, session: { sessionId: "root", cwd: process.cwd() } });
  const first = await execution.start({
    parentId: root,
    definition: definitionRef(AGENT_SCOUT),
    input: { objective: "inspect a difficult repository state" },
    wait: "await",
  });

  for (let index = 0; index < 200; index += 1) {
    backend.sessions[0]?.emit({ type: "tool.started", toolName: "read" });
  }
  await eventually(() => store.projection.toolCallCounts.get(first.id) === 200);
  assert.equal(store.projection.requireRun(first.id).state, "running");
  assert.equal(store.projection.requireRun(first.id).compiled.limits.maxToolCalls, undefined);

  await backend.tool(0, "phenix_fail").execute({
    summary: "Repository lock state prevents further progress.",
    category: "deadlock",
    retryable: true,
    requestedTools: ["bash"],
    suggestedLimits: { timeoutMs: 600_000, maxToolCalls: null },
  });
  const failed = await first.result();
  assert.equal(failed.status, "failure");
  if (failed.status !== "failure") throw new Error("Expected failure");
  assert.equal(failed.failure.code, "agent_reported_failure");
  const report = failed.failure.details as FailureReport;
  assert.equal(report.category, "deadlock");
  assert.deepEqual(report.requestedTools, ["bash"]);

  const retry = await execution.retry(root, first.id, {
    wait: "background",
    addTools: ["bash"],
    limits: { timeoutMs: 600_000, maxTurns: null, maxToolCalls: null },
  });
  const retrySnapshot = await retry.snapshot();
  assert.equal(retrySnapshot.compiled.invocation.retryOf, first.id);
  assert.ok(retrySnapshot.compiled.tools.includes("bash"));
  assert.equal(retrySnapshot.compiled.limits.maxTurns, undefined);
  assert.equal(retrySnapshot.compiled.limits.maxToolCalls, undefined);
  assert.ok(backend.specs[1]?.tools.includes("phenix_fail"));
  assert.ok(backend.specs[1]?.tools.includes("bash"));

  await assert.rejects(
    execution.retry(root, first.id, { addTools: ["edit"] }),
    /may not grant tool edit/,
  );
  await retry.cancel("test complete");
});

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Condition was not reached");
}
''')
