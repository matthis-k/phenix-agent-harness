import type {
  AgentDefinition,
  AnyDefinition,
  CapabilitySet,
  InvokeNode,
  WorkflowDefinition,
} from "../domain/definition/definition.ts";
import type { BudgetMode } from "../domain/definition/effort.ts";
import type { Difficulty, ResolvedModel } from "../domain/definition/model.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type {
  CompiledRunSpec,
  RunLimits,
  RunRecord,
  RunRetryOptions,
  StartRun,
  WorkflowCausation,
} from "../domain/run/model.ts";
import type { DefinitionId, RunId } from "../domain/shared.ts";
import { passthroughBudgetPolicy, type BudgetPolicy } from "../ports/budget-policy.ts";
import type { ModelResolver } from "../ports/model-resolver.ts";
import type { DefinitionCatalog } from "./catalog.ts";
import type { ExecutionStore } from "./execution-store.ts";

export interface RunAdmissionRequest {
  readonly lifetime?: StartRun<unknown, unknown>["lifetime"];
  readonly causation?: WorkflowCausation;
  readonly trustedWorkflowInvocation?: boolean;
  readonly retryOf?: RunId;
}

/**
 * Decides whether a run may enter the execution tree and compiles its immutable runtime policy.
 * It owns invocation authorization, retry escalation, capability narrowing, and model routing;
 * lifecycle mutation remains in ExecutionFacadeImpl.
 */
export class RunAdmissionPolicy {
  private readonly catalog: DefinitionCatalog;
  private readonly store: ExecutionStore;
  private readonly models: ModelResolver;
  private readonly budgetPolicy: BudgetPolicy;
  private readonly rootInvokableDefinitions: readonly DefinitionId[];

  constructor(input: {
    readonly catalog: DefinitionCatalog;
    readonly store: ExecutionStore;
    readonly models: ModelResolver;
    readonly budgetPolicy?: BudgetPolicy;
    readonly rootInvokableDefinitions: readonly DefinitionId[];
  }) {
    this.catalog = input.catalog;
    this.store = input.store;
    this.models = input.models;
    this.budgetPolicy = input.budgetPolicy ?? passthroughBudgetPolicy;
    this.rootInvokableDefinitions = input.rootInvokableDefinitions;
  }

  authorize(
    parent: RunRecord,
    definition: AnyDefinition,
    request: RunAdmissionRequest,
  ): Partial<CapabilitySet> | undefined {
    if (request.retryOf) {
      const original = this.store.projection.requireRun(request.retryOf);
      this.assertRetryAccessible(parent, original);
      if (original.definitionId !== definition.id) {
        throw new Error(
          `Retry definition ${definition.id} does not match ${original.definitionId}`,
        );
      }
      return undefined;
    }

    const workflowInvocation = this.authorizedWorkflowInvocation(parent, definition, request);
    const capabilities: CapabilitySet = workflowInvocation
      ? {
          invokableDefinitions: [definition.id],
          maxDepth: parent.compiled.capabilities.maxDepth,
          mayDetach: false,
          maySend: false,
          mayCancelChildren: true,
        }
      : parent.compiled.capabilities;
    const invokableDefinitions =
      parent.kind === "root" ? this.rootInvokableDefinitions : capabilities.invokableDefinitions;
    const nextDepth = this.depthOf(parent.id) + 1;
    const requestsDetachment = request.lifetime === "detached-to-root";

    if (!invokableDefinitions.includes(definition.id)) {
      throw new Error(`Parent ${parent.id} cannot invoke ${definition.id}`);
    }
    if (nextDepth > capabilities.maxDepth) {
      throw new Error(`Invocation of ${definition.id} exceeds delegation depth`);
    }
    if (requestsDetachment && !capabilities.mayDetach) {
      throw new Error(`Parent ${parent.id} may not detach children`);
    }

    return workflowInvocation?.capabilityOverride;
  }

  assertRetryAccessible(caller: RunRecord, target: RunRecord): void {
    if (target.kind === "root") throw new Error(`The root run cannot be retried`);
    if (this.store.projection.rootOf(caller.id) !== this.store.projection.rootOf(target.id)) {
      throw new Error(`Run ${target.id} is outside caller ${caller.id}'s root scope`);
    }
    const isRetryableTerminal =
      isTerminalRunState(target.state) &&
      target.outcome !== undefined &&
      target.outcome.status !== "success";
    if (!isRetryableTerminal) {
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

  normalizeRetryOverrides(
    kind: RunRecord["kind"],
    options: RunRetryOptions,
  ): Omit<RunRetryOptions, "wait"> | undefined {
    const addTools = [...new Set(options.addTools ?? [])];
    const overridesAgentRuntime = addTools.length > 0 || options.limits !== undefined;
    if (kind !== "agent" && overridesAgentRuntime) {
      throw new Error(`Only agent retries may override tools or limits`);
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

  capabilitiesFor(
    definition: AnyDefinition,
    parentCapabilities: CapabilitySet,
    override?: Partial<CapabilitySet>,
  ): CapabilitySet {
    const base: CapabilitySet =
      definition.kind === "agent"
        ? {
            ...definition.childCapabilities,
            maxDepth: Math.min(definition.childCapabilities.maxDepth, parentCapabilities.maxDepth),
          }
        : {
            invokableDefinitions: definition.graph.nodes.flatMap((node) =>
              node.kind === "invoke" ? [node.definition.id] : [],
            ),
            maxDepth: parentCapabilities.maxDepth,
            mayDetach: false,
            maySend: false,
            mayCancelChildren: true,
          };
    if (!override) return base;

    const allowedDefinitions = new Set(override.invokableDefinitions ?? base.invokableDefinitions);
    return {
      invokableDefinitions: base.invokableDefinitions.filter((id) => allowedDefinitions.has(id)),
      maxDepth: Math.min(base.maxDepth, override.maxDepth ?? base.maxDepth),
      mayDetach: base.mayDetach && (override.mayDetach ?? true),
      maySend: base.maySend && (override.maySend ?? true),
      mayCancelChildren: base.mayCancelChildren && (override.mayCancelChildren ?? true),
    };
  }

  compile(input: {
    readonly definition: AnyDefinition;
    readonly validatedInput: unknown;
    readonly difficulty: Difficulty;
    readonly budget: BudgetMode;
    readonly capabilities: CapabilitySet;
    readonly wait: "await" | "background";
    readonly causation?: WorkflowCausation;
    readonly retryOf?: RunId;
    readonly retryOverrides?: Omit<RunRetryOptions, "wait">;
  }): CompiledRunSpec {
    const invocation = {
      wait: input.wait,
      ...(input.causation ? { causation: input.causation } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    };
    const { definition } = input;

    if (definition.kind === "agent") {
      const route = definition.modelRoutes?.[input.difficulty];
      return {
        definitionId: definition.id,
        input: input.validatedInput,
        outputSchemaId: definition.output.id,
        tools: applyRetryTools(definition.tools.allow, input.retryOverrides?.addTools),
        contextPolicy: definition.context,
        modelSelector: route?.model ?? definition.model,
        difficulty: input.difficulty,
        budget: input.budget,
        limits: applyRetryLimits(
          this.budgetPolicy.applyAgentLimits(definition.limits, input.budget),
          input.retryOverrides?.limits,
        ),
        capabilities: input.capabilities,
        invocation,
      };
    }
    return {
      definitionId: definition.id,
      input: input.validatedInput,
      outputSchemaId: definition.output.id,
      tools: [],
      difficulty: input.difficulty,
      limits: definition.limits,
      capabilities: input.capabilities,
      invocation,
    };
  }

  resolveModel(
    definition: AgentDefinition<unknown, unknown>,
    parentDefinitionId: string,
    difficulty: Difficulty,
    budget: BudgetMode,
  ): Promise<ResolvedModel> {
    const route = definition.modelRoutes?.[difficulty];
    return this.models.resolve(route?.model ?? definition.model, {
      definitionId: definition.id,
      parentDefinitionId,
      thinking: route?.thinking ?? definition.thinking,
      difficulty,
      budget,
      ...(route ? { capability: route.capability } : {}),
    });
  }

  depthOf(runId: RunId): number {
    let depth = 0;
    let current = this.store.projection.requireRun(runId);
    while (current.parentId) {
      depth += 1;
      current = this.store.projection.requireRun(current.parentId);
    }
    return depth;
  }

  private authorizedWorkflowInvocation(
    parent: RunRecord,
    definition: AnyDefinition,
    request: RunAdmissionRequest,
  ): InvokeNode | undefined {
    if (parent.kind !== "workflow") return undefined;

    const causation = request.causation;
    if (!request.trustedWorkflowInvocation || !causation) {
      throw new Error(`Workflow children may only be started by their process manager`);
    }

    const workflow = this.catalog.require(parent.definitionId) as WorkflowDefinition<
      unknown,
      unknown
    >;
    const invocation = workflow.graph.nodes.find(
      (node): node is InvokeNode => node.kind === "invoke" && node.id === causation.nodeId,
    );
    if (!invocation || invocation.definition.id !== definition.id) {
      throw new Error(`Definition ${definition.id} is not authorized at workflow node`);
    }
    if (!parent.compiled.capabilities.invokableDefinitions.includes(definition.id)) {
      throw new Error(`Workflow capability scope excludes ${definition.id}`);
    }
    return invocation;
  }
}

const RECOVERY_ADDITIONAL_TOOLS = new Set(["read", "grep", "find", "ls", "bash"]);

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

function applyRetryTools(
  base: readonly string[],
  additions: readonly string[] = [],
): readonly string[] {
  return [...new Set([...base, ...additions])];
}

function applyRetryLimits(
  base: RunLimits,
  override?: NonNullable<RunRetryOptions["limits"]>,
): RunLimits {
  if (!override) return base;
  const timeoutMs = override.timeoutMs ?? base.timeoutMs;
  const maxTurns = override.maxTurns === null ? undefined : (override.maxTurns ?? base.maxTurns);
  const maxToolCalls =
    override.maxToolCalls === null ? undefined : (override.maxToolCalls ?? base.maxToolCalls);
  const maxRepairAttempts = override.maxRepairAttempts ?? base.maxRepairAttempts;
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(maxRepairAttempts !== undefined ? { maxRepairAttempts } : {}),
    ...(base.maxNodeRuns !== undefined ? { maxNodeRuns: base.maxNodeRuns } : {}),
    ...(base.maxParallelism !== undefined ? { maxParallelism: base.maxParallelism } : {}),
  };
}
