import type { AgentDefinition, AnyDefinition } from "../domain/definition/definition.ts";
import { defineSchema } from "../domain/definition/schema.ts";
import type { DomainEvent } from "../domain/run/events.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
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
  unsubscribe: () => void;
  timeout?: ReturnType<typeof setTimeout>;
}

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
    const customTools = await this.buildTools(command.runId, definition);
    if (!this.isActive(command.runId)) return;
    const spec: CreateAgentSessionSpec = {
      runId: command.runId,
      cwd: this.cwd,
      model: command.resolvedModel.concrete,
      thinking: command.resolvedModel.thinking,
      systemPrompt: this.systemPrompt(definition, command.input),
      tools: [...new Set([...definition.tools.allow, "phenix_return"])],
      customTools,
      context: definition.context,
      persistence: definition.persistence,
    };
    const session = await this.backend.create(spec);
    if (!this.isActive(command.runId)) {
      await session.dispose();
      return;
    }
    const live = this.attach(command.runId, definition, session);
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
    const customTools = await this.buildTools(command.runId, definition);
    const spec: CreateAgentSessionSpec = {
      runId: command.runId,
      cwd: this.cwd,
      model: command.resolvedModel.concrete,
      thinking: command.resolvedModel.thinking,
      systemPrompt: this.systemPrompt(definition, command.input),
      tools: [...new Set([...definition.tools.allow, "phenix_return"])],
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
    const live = this.attach(command.runId, definition, session);
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
      previousCycle.number > definition.limits.maxRepairAttempts
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
    session: AgentSessionPort,
  ): LiveAgent {
    const live: LiveAgent = {
      session,
      definition,
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
    const allowed = new Set(definition.tools.allow);
    return [completion, ...childTools.filter((tool) => allowed.has(tool.name))];
  }

  private async observe(runId: RunId, event: AgentSessionObservation): Promise<void> {
    const live = this.live.get(runId);
    const run = this.store.projection.runs.get(runId);
    if (!live || !run || isTerminalRunState(run.state) || this.controller.isTerminating(runId)) {
      return;
    }

    if (event.type === "turn.ended") {
      const turns = await this.controller.turnEnded(runId);
      if (turns > live.definition.limits.maxTurns) {
        await this.controller.fail(runId, {
          code: "turn_budget_exceeded",
          message: `Agent exceeded ${live.definition.limits.maxTurns} turns`,
          retryable: false,
        });
      }
      return;
    }
    if (event.type === "tool.started") {
      const toolCalls = await this.controller.toolStarted(runId, event.toolName);
      if (toolCalls > live.definition.limits.maxToolCalls) {
        await this.controller.fail(runId, {
          code: "tool_budget_exceeded",
          message: `Agent exceeded ${live.definition.limits.maxToolCalls} tool calls`,
          retryable: false,
        });
      }
      return;
    }
    if (event.type === "backend.failed") {
      await this.controller.fail(runId, {
        code: "provider_failed",
        message: event.message,
        retryable: event.retryable,
      });
      return;
    }

    const settledCycle = this.store.projection.cycles.get(runId)?.number ?? 1;
    await this.controller.cycleSettled(runId, settledCycle);
    if (this.store.projection.submittedOutputs.has(runId)) {
      await this.tryFinalize(runId);
      return;
    }
    if (settledCycle > live.definition.limits.maxRepairAttempts) {
      await this.controller.fail(runId, {
        code: "output_missing",
        message: `Agent settled without phenix_return after ${settledCycle} cycle(s)`,
        retryable: false,
      });
      return;
    }
    await this.controller.cycleStarted(runId, settledCycle + 1);
    try {
      await live.session.followUp(
        "The run is not complete: submit the required typed result with phenix_return. Do not only describe it in text.",
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
    await this.controller.fail(runId, {
      code: "provider_failed",
      message: `Agent session observation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      retryable: false,
    });
  }

  private isActive(runId: RunId): boolean {
    const run = this.store.projection.runs.get(runId);
    return Boolean(run && !isTerminalRunState(run.state) && !this.controller.isTerminating(runId));
  }

  private armTimeout(runId: RunId, live: LiveAgent): void {
    if (live.definition.limits.timeoutMs <= 0) return;
    const run = this.store.projection.requireRun(runId);
    const requestedAt = Date.parse(run.requestedAt);
    const now = Date.parse(this.clock.now());
    const elapsed =
      Number.isFinite(requestedAt) && Number.isFinite(now) ? Math.max(0, now - requestedAt) : 0;
    const remaining = Math.max(0, live.definition.limits.timeoutMs - elapsed);
    live.timeout = setTimeout(() => {
      void this.controller
        .fail(runId, {
          code: "timeout",
          message: `Agent timed out after ${live.definition.limits.timeoutMs}ms`,
          retryable: false,
        })
        .catch(() => undefined);
    }, remaining);
    live.timeout.unref?.();
  }

  private systemPrompt(definition: AgentDefinition<unknown, unknown>, input: unknown): string {
    return `${definition.prompt.render(input)}\n\nExecution protocol:\n- You are run-scoped and own only the supplied task.\n- Use only the exact tools provided by this definition.\n- A settled Pi cycle is not completion.\n- Finish only by calling phenix_return with an output matching schema ${definition.output.id}.\n- Background children remain attached; resolve or cancel them before returning.`;
  }

  private requireLive(runId: RunId): LiveAgent {
    const live = this.live.get(runId);
    if (!live) throw new Error(`No live Pi session for ${runId}`);
    return live;
  }
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
