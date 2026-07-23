import { Type } from "typebox";

import type { AgentDefinition, AnyDefinition } from "../domain/definition/definition.ts";
import { defineSchema } from "../domain/definition/schema.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunLimits, RunRecord } from "../domain/run/model.ts";
import type {
  Failure,
  FailureCategory,
  FailureLimitSuggestion,
  FailureReport,
  RunId,
} from "../domain/shared.ts";
import type {
  AgentSessionBackend,
  AgentSessionObservation,
  AgentSessionPort,
  AgentTool,
  CreateAgentSessionSpec,
} from "../ports/agent-session-backend.ts";
import type { Clock } from "../ports/clock.ts";
import type { AgentToolFactory } from "./agent-tools.ts";
import type {
  RunController,
  RunImplementation,
  StartImplementationCommand,
} from "./execution-facade.ts";
import type { ExecutionStore } from "./execution-store.ts";
import { KeyedSerialExecutor } from "./keyed-serial-executor.ts";

interface LiveAgent {
  readonly session: AgentSessionPort;
  readonly definition: AgentDefinition<unknown, unknown>;
  readonly limits: RunLimits;
  unsubscribe: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface AgentFailureInput {
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

export class AgentExecutor implements RunImplementation {
  private readonly backend: AgentSessionBackend;
  private readonly controller: RunController;
  private readonly tools: AgentToolFactory;
  private readonly store: ExecutionStore;
  private readonly cwd: string;
  private readonly clock: Clock;
  private readonly live = new Map<RunId, LiveAgent>();
  private readonly serial = new KeyedSerialExecutor<RunId>();
  private readonly unsubscribeEvents: () => void;

  constructor(input: {
    readonly backend: AgentSessionBackend;
    readonly controller: RunController;
    readonly tools: AgentToolFactory;
    readonly store: ExecutionStore;
    readonly cwd: string;
    readonly clock: Clock;
  }) {
    this.backend = input.backend;
    this.controller = input.controller;
    this.tools = input.tools;
    this.store = input.store;
    this.cwd = input.cwd;
    this.clock = input.clock;
    this.unsubscribeEvents = this.store.events.subscribe((event) => this.onDomainEvent(event));
  }

  async start(command: StartImplementationCommand): Promise<void> {
    const definition = requireAgent(command.definition);
    if (!command.resolvedModel) throw new Error(`Agent run has no resolved model`);
    await this.controller.transition(command.runId, "starting");
    if (!this.isActive(command.runId)) return;
    const compiled = this.store.projection.requireRun(command.runId).compiled;
    const customTools = await this.buildTools(command.runId, definition, compiled.tools);
    if (!this.isActive(command.runId)) return;
    const spec: CreateAgentSessionSpec = {
      runId: command.runId,
      cwd: this.cwd,
      model: command.resolvedModel.concrete,
      thinking: command.resolvedModel.thinking,
      systemPrompt: this.systemPrompt(definition, command.input),
      tools: [...new Set([...compiled.tools, "phenix_return", "phenix_fail"])],
      customTools,
      context: definition.context,
      persistence: definition.persistence,
    };
    const session = await this.backend.create(spec);
    if (!this.isActive(command.runId)) {
      await session.dispose();
      return;
    }
    const live = this.attach(command.runId, definition, compiled.limits, session);
    try {
      await this.controller.bindPi(command.runId, session.reference);
      if (!this.isActive(command.runId)) {
        await this.dispose(command.runId);
        return;
      }
      await this.controller.transition(command.runId, "running");
      if (!this.isActive(command.runId)) {
        await this.dispose(command.runId);
        return;
      }
      await this.controller.cycleStarted(command.runId, 1);
      this.armTimeout(command.runId, live);
      await session.prompt(renderInitialInput(command.input));
    } catch (error) {
      await this.dispose(command.runId).catch(() => undefined);
      throw error;
    }
  }

  async recover(command: StartImplementationCommand, record: RunRecord): Promise<boolean> {
    const definition = requireAgent(command.definition);
    if (definition.persistence !== "file" || !record.pi || !command.resolvedModel) return false;
    const compiled = this.store.projection.requireRun(command.runId).compiled;
    const customTools = await this.buildTools(command.runId, definition, compiled.tools);
    const spec: CreateAgentSessionSpec = {
      runId: command.runId,
      cwd: this.cwd,
      model: command.resolvedModel.concrete,
      thinking: command.resolvedModel.thinking,
      systemPrompt: this.systemPrompt(definition, command.input),
      tools: [...new Set([...compiled.tools, "phenix_return", "phenix_fail"])],
      customTools,
      context: definition.context,
      persistence: definition.persistence,
    };
    const session = await this.backend.recover(spec, record.pi);
    if (!session) return false;
    if (!this.isActive(command.runId)) {
      await session.dispose();
      return true;
    }
    const live = this.attach(command.runId, definition, compiled.limits, session);
    this.armTimeout(command.runId, live);
    const previousCycle = this.store.projection.cycles.get(command.runId);
    if (this.store.projection.submittedOutputs.has(command.runId)) {
      await this.tryFinalize(command.runId);
      if (!this.isActive(command.runId) || previousCycle?.state === "idle") return true;
      await this.controller.transition(command.runId, "running");
      const cycle = (previousCycle?.number ?? 0) + 1;
      await this.controller.cycleStarted(command.runId, cycle);
      try {
        await session.followUp(
          "A typed output is already accepted. Conclude this recovery cycle without resubmitting it.",
        );
      } catch (error) {
        await this.controller.fail(command.runId, {
          code: "provider_failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
      return true;
    }
    await this.controller.transition(command.runId, "running");
    if (
      previousCycle?.state === "idle" &&
      previousCycle.number > (compiled.limits.maxRepairAttempts ?? 0)
    ) {
      await this.controller.fail(command.runId, {
        code: "output_missing",
        message: `Agent settled without phenix_return after ${previousCycle.number} cycle(s)`,
        retryable: false,
      });
      return true;
    }
    const cycle = (previousCycle?.number ?? 0) + 1;
    await this.controller.cycleStarted(command.runId, cycle);
    try {
      await session.followUp(
        "Resume this run and submit the required typed output with phenix_return.",
      );
    } catch (error) {
      await this.controller.fail(command.runId, {
        code: "provider_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
    return true;
  }

  async send(runId: RunId, message: string, delivery: "normal" | "nextTurn"): Promise<void> {
    const live = this.requireLive(runId);
    if (delivery === "nextTurn") {
      await live.session.notify(message);
      return;
    }
    if (live.session.isStreaming) {
      await live.session.steer(message);
      return;
    }
    const cycle = (this.store.projection.cycles.get(runId)?.number ?? 0) + 1;
    await this.controller.cycleStarted(runId, cycle);
    await live.session.prompt(message);
  }

  async cancel(runId: RunId): Promise<void> {
    const live = this.live.get(runId);
    if (!live) return;
    clearTimeout(live.timeout);
    try {
      await live.session.abort();
    } finally {
      await this.dispose(runId);
    }
  }

  async dispose(runId: RunId): Promise<void> {
    const live = this.live.get(runId);
    if (!live) return;
    this.live.delete(runId);
    clearTimeout(live.timeout);
    live.unsubscribe();
    await live.session.dispose();
  }

  async shutdown(): Promise<void> {
    this.unsubscribeEvents();
    await Promise.allSettled([...this.live.keys()].map((runId) => this.dispose(runId)));
  }

  private attach(
    runId: RunId,
    definition: AgentDefinition<unknown, unknown>,
    limits: RunLimits,
    session: AgentSessionPort,
  ): LiveAgent {
    const live: LiveAgent = {
      session,
      definition,
      limits,
      unsubscribe: () => undefined,
    };
    live.unsubscribe = session.subscribe((event) => {
      void this.serial
        .run(runId, () => this.observe(runId, event))
        .catch((error: unknown) => {
          void this.failObservation(runId, error).catch(() => undefined);
        });
    });
    this.live.set(runId, live);
    return live;
  }

  private async buildTools(
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

  private async observe(runId: RunId, event: AgentSessionObservation): Promise<void> {
    const live = this.live.get(runId);
    const run = this.store.projection.runs.get(runId);
    if (!live || !run || isTerminalRunState(run.state) || this.controller.isTerminating(runId)) {
      return;
    }

    if (event.type === "turn.ended") {
      const turns = await this.controller.turnEnded(runId);
      const maxTurns = live.definition.limits.maxTurns;
      if (maxTurns !== undefined && turns > maxTurns) {
        await this.controller.fail(
          runId,
          automaticFailure(
            "turn_budget_exceeded",
            `Agent exceeded ${maxTurns} turns`,
            "resource_limit",
            true,
            { maxTurns: Math.max(maxTurns * 2, turns + 4) },
          ),
        );
      }
      return;
    }
    if (event.type === "tool.started") {
      const toolCalls = await this.controller.toolStarted(runId, event.toolName);
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
      }
      return;
    }
    if (event.type === "backend.failed") {
      await this.controller.fail(
        runId,
        automaticFailure("provider_failed", event.message, "external_failure", event.retryable),
      );
      return;
    }

    const settledCycle = this.store.projection.cycles.get(runId)?.number ?? 1;
    await this.controller.cycleSettled(runId, settledCycle);
    if (this.store.projection.submittedOutputs.has(runId)) {
      await this.tryFinalize(runId);
      return;
    }
    const maxRepairAttempts = live.limits.maxRepairAttempts ?? 0;
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
      );
      return;
    }
    await this.controller.cycleStarted(runId, settledCycle + 1);
    try {
      await live.session.followUp(
        "The run is not complete: call phenix_return with the typed result, or phenix_fail with a short structured report if blocked or deadlocked.",
      );
    } catch (error) {
      await this.controller.fail(runId, {
        code: "provider_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  }

  private async tryFinalize(runId: RunId): Promise<void> {
    const run = this.store.projection.runs.get(runId);
    if (!run || isTerminalRunState(run.state) || this.controller.isTerminating(runId)) return;
    const cycle = this.store.projection.cycles.get(runId);
    const output = this.store.projection.submittedOutputs.get(runId);
    if (output === undefined || cycle?.state !== "idle") return;
    if (this.controller.activeAttachedChildren(runId).length > 0) return;
    await this.controller.complete(runId, output);
    await this.dispose(runId);
  }

  private async onDomainEvent(event: DomainEvent): Promise<void> {
    if (!isTerminalEvent(event.type)) return;
    const child = this.store.projection.runs.get(event.runId);
    if (!child?.parentId || child.ownership !== "attached") return;
    if (!this.live.has(child.parentId)) return;
    await this.serial.run(child.parentId, () => this.tryFinalize(child.parentId as RunId));
  }

  private async failObservation(runId: RunId, error: unknown): Promise<void> {
    if (!this.isActive(runId)) return;
    await this.controller.fail(
      runId,
      automaticFailure(
        "provider_failed",
        `Agent session observation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "external_failure",
        true,
      ),
    );
  }

  private isActive(runId: RunId): boolean {
    const run = this.store.projection.runs.get(runId);
    return Boolean(run && !isTerminalRunState(run.state) && !this.controller.isTerminating(runId));
  }

  private armTimeout(runId: RunId, live: LiveAgent): void {
    if (live.limits.timeoutMs <= 0) return;
    const run = this.store.projection.requireRun(runId);
    const requestedAt = Date.parse(run.requestedAt);
    const now = Date.parse(this.clock.now());
    const elapsed =
      Number.isFinite(requestedAt) && Number.isFinite(now) ? Math.max(0, now - requestedAt) : 0;
    const remaining = Math.max(0, live.limits.timeoutMs - elapsed);
    live.timeout = setTimeout(() => {
      void this.controller
        .fail(
          runId,
          automaticFailure(
            "timeout",
            `Agent timed out after ${live.limits.timeoutMs}ms`,
            "resource_limit",
            true,
            { timeoutMs: Math.min(3_600_000, Math.max(live.limits.timeoutMs * 2, 60_000)) },
          ),
        )
        .catch(() => undefined);
    }, remaining);
    live.timeout.unref?.();
  }

  private systemPrompt(definition: AgentDefinition<unknown, unknown>, input: unknown): string {
    return `${definition.prompt.render(input)}\n\nExecution protocol:\n- You are run-scoped and own only the supplied task.\n- Use only the exact tools provided by this definition.\n- A settled Pi cycle is not completion.\n- Finish successfully only by calling phenix_return with an output matching schema ${definition.output.id}.\n- If blocked, deadlocked, missing permissions, or unable to produce a valid result, call phenix_fail with a short report instead of looping or inventing success.\n- When a child fails, inspect its report, surface it explicitly, and decide whether a bounded phenix_handle retry is appropriate.\n- Background children remain attached; resolve, retry, or cancel them before returning.`;
  }

  private requireLive(runId: RunId): LiveAgent {
    const live = this.live.get(runId);
    if (!live) throw new Error(`No live Pi session for ${runId}`);
    return live;
  }
}

function automaticFailure(
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

function requireAgent(definition: AnyDefinition): AgentDefinition<unknown, unknown> {
  if (definition.kind !== "agent") throw new Error(`${definition.id} is not an agent definition`);
  return definition;
}

function renderInitialInput(input: unknown): string {
  return `Execute this typed input:\n${JSON.stringify(input, null, 2)}`;
}

function isTerminalEvent(type: string): boolean {
  return ["run.completed", "run.failed", "run.cancelled", "run.orphaned"].includes(type);
}
