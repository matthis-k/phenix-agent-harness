import type {
  DispatchCandidate,
  DispatchDecision,
  DispatchRoute,
} from "../definitions/dispatch.ts";
import type {
  DynamicWorkflowCandidate,
  DynamicWorkflowCompositionRequest,
  DynamicWorkflowProposal,
} from "../definitions/dynamic-workflow.ts";
import {
  AGENT_COORDINATOR,
  AGENT_DISPATCHER,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_QA,
} from "../definitions/ids.ts";
import { type ObjectiveRequest, ObjectiveRequestSchema } from "../definitions/schemas.ts";
import {
  type AgentDefinition,
  type AnyDefinition,
  type DefinitionRef,
  definitionRef,
} from "../domain/definition/definition.ts";
import type { DefinitionId, Outcome, RunId } from "../domain/shared.ts";
import { awaitOutcomeOrBudget, type BudgetSuspension } from "./budget-suspension.ts";
import type { DynamicWorkflowExecutionService } from "./dynamic-workflow-execution.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { CatalogFacade, DefinitionSummary, ExecutionFacade, RunHandle } from "./interfaces.ts";
import type { InvocationPolicy } from "./invocation-policy.ts";

export type DispatchMode = "auto" | DispatchRoute;

export interface DispatchRequest extends ObjectiveRequest {
  readonly mode?: DispatchMode;
  readonly wait?: "await" | "background";
}

export interface DispatchResult {
  readonly definition: DefinitionId;
  readonly selectedBy: "explicit" | "dispatcher";
  readonly runId: RunId;
  readonly classifierRunId?: RunId;
  readonly composerRunId?: RunId;
  readonly status: "running" | "completed" | "suspended";
  readonly outcome?: Outcome<unknown>;
  readonly suspension?: BudgetSuspension;
}

interface DispatchSelection {
  readonly target: DefinitionRef<unknown, unknown>;
  readonly selectedBy: DispatchResult["selectedBy"];
  readonly classifierRunId?: RunId;
}

type DispatchWait = NonNullable<DispatchRequest["wait"]>;

export class DispatchService {
  private readonly execution: ExecutionFacade;
  private readonly dynamicWorkflows: DynamicWorkflowExecutionService;
  private readonly catalog: CatalogFacade;
  private readonly store: ExecutionStore;
  private readonly invocationPolicy: InvocationPolicy;

  constructor(input: {
    readonly execution: ExecutionFacade;
    readonly dynamicWorkflows: DynamicWorkflowExecutionService;
    readonly catalog: CatalogFacade;
    readonly store: ExecutionStore;
    readonly invocationPolicy: InvocationPolicy;
  }) {
    this.execution = input.execution;
    this.dynamicWorkflows = input.dynamicWorkflows;
    this.catalog = input.catalog;
    this.store = input.store;
    this.invocationPolicy = input.invocationPolicy;
  }

  async dispatch(
    parentId: RunId,
    request: DispatchRequest,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    const objective = request.objective.trim();
    if (!objective) throw new Error("Dispatch objective must not be empty");

    const input: ObjectiveRequest = {
      objective,
      ...(request.context === undefined ? {} : { context: request.context }),
    };
    const wait = request.wait ?? "await";
    const selection = await this.selectTarget(parentId, input, request.mode, signal);

    if (selection.target.id === AGENT_COORDINATOR) {
      return this.compose(parentId, input, wait, selection, signal);
    }

    this.assertAllowed(parentId, this.catalog.get(selection.target) as AnyDefinition, input);
    const handle = await this.execution.start({
      parentId,
      definition: selection.target,
      input,
      wait,
    });
    return this.resultForHandle({
      handle,
      definition: selection.target.id,
      selectedBy: selection.selectedBy,
      ...(selection.classifierRunId ? { classifierRunId: selection.classifierRunId } : {}),
      wait,
      signal,
    });
  }

  private async selectTarget(
    parentId: RunId,
    input: ObjectiveRequest,
    mode: DispatchMode | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DispatchSelection> {
    if (mode && mode !== "auto") {
      return { target: definitionForRoute(mode), selectedBy: "explicit" };
    }

    const candidates = selectDispatchCandidates(await this.catalog.listAvailable(parentId));
    if (candidates.length === 0) {
      throw new Error("No workflow or dynamic composer is available for dispatch");
    }

    const classifierRef = definitionRef(AGENT_DISPATCHER);
    const classifierInput = { ...input, candidates };
    this.assertAllowed(
      parentId,
      this.catalog.get(classifierRef) as AnyDefinition,
      classifierInput,
    );
    const classifier = await this.execution.start({
      parentId,
      definition: classifierRef,
      input: classifierInput,
      wait: "await",
    });
    const decision = await classifier.result(signal);
    if (decision.status !== "success") {
      throw new Error(`Dispatch selector failed: ${describeOutcome(decision)}`);
    }
    const selected = requireSelectedCandidate(candidates, decision.value as DispatchDecision);
    return {
      target: definitionRef(selected.definitionId),
      selectedBy: "dispatcher",
      classifierRunId: classifier.id,
    };
  }

  private async compose(
    parentId: RunId,
    input: ObjectiveRequest,
    wait: DispatchWait,
    selection: DispatchSelection,
    signal: AbortSignal | undefined,
  ): Promise<DispatchResult> {
    const composerRef = definitionRef<DynamicWorkflowCompositionRequest, DynamicWorkflowProposal>(
      AGENT_COORDINATOR,
    );
    const composerDefinition = this.catalog.get(composerRef) as AgentDefinition<
      DynamicWorkflowCompositionRequest,
      DynamicWorkflowProposal
    >;
    const composerInput: DynamicWorkflowCompositionRequest = {
      ...input,
      workflowInputSchema: ObjectiveRequestSchema.id,
      candidates: compositionCandidates(composerDefinition, this.catalog),
    };
    this.assertAllowed(parentId, composerDefinition, composerInput);
    const composer = await this.execution.start({
      parentId,
      definition: composerRef,
      input: composerInput,
      wait: "await",
    });
    const composed = await composer.result(signal);
    if (composed.status !== "success") {
      throw new Error(`Dynamic workflow composer failed: ${describeOutcome(composed)}`);
    }

    const handle = await this.dynamicWorkflows.start({
      parentId,
      scopeRunId: composer.id,
      proposal: composed.value,
      input,
      wait,
    });
    const definition = this.store.projection.requireRun(handle.id).definitionId;
    return this.resultForHandle({
      handle,
      definition,
      selectedBy: selection.selectedBy,
      ...(selection.classifierRunId ? { classifierRunId: selection.classifierRunId } : {}),
      composerRunId: composer.id,
      wait,
      signal,
    });
  }

  private async resultForHandle(input: {
    readonly handle: RunHandle<unknown>;
    readonly definition: DefinitionId;
    readonly selectedBy: DispatchResult["selectedBy"];
    readonly classifierRunId?: RunId;
    readonly composerRunId?: RunId;
    readonly wait: DispatchWait;
    readonly signal?: AbortSignal;
  }): Promise<DispatchResult> {
    const result = {
      definition: input.definition,
      selectedBy: input.selectedBy,
      runId: input.handle.id,
      ...(input.classifierRunId ? { classifierRunId: input.classifierRunId } : {}),
      ...(input.composerRunId ? { composerRunId: input.composerRunId } : {}),
    };
    if (input.wait === "background") return { ...result, status: "running" };

    const settled = await awaitOutcomeOrBudget({
      store: this.store,
      runId: input.handle.id,
      signal: input.signal,
    });
    if (settled.status === "suspended") {
      return { ...result, status: "suspended", suspension: settled.suspension };
    }
    return { ...result, status: "completed", outcome: settled.outcome };
  }

  private assertAllowed(parentId: RunId, definition: AnyDefinition, input: unknown): void {
    this.invocationPolicy.assertAllowed({
      rootRunId: this.store.projection.rootOf(parentId),
      parent: this.store.projection.requireRun(parentId),
      definition,
      input,
    });
  }
}

export function selectDispatchCandidates(
  available: readonly DefinitionSummary[],
): readonly DispatchCandidate[] {
  return available
    .filter((definition) => definition.kind === "workflow" || definition.id === AGENT_COORDINATOR)
    .map((definition) => ({
      definitionId: definition.id,
      kind: definition.kind === "workflow" ? "workflow" : "generic",
      title: definition.title,
      description: definition.description,
    }));
}

export function requireSelectedCandidate(
  candidates: readonly DispatchCandidate[],
  decision: DispatchDecision,
): DispatchCandidate {
  const selected = candidates.find((candidate) => candidate.definitionId === decision.definitionId);
  if (!selected) {
    throw new Error(`Dispatch selector chose unavailable definition ${decision.definitionId}`);
  }
  return selected;
}

function compositionCandidates(
  composer: AgentDefinition<DynamicWorkflowCompositionRequest, DynamicWorkflowProposal>,
  catalog: CatalogFacade,
): readonly DynamicWorkflowCandidate[] {
  return composer.childCapabilities.invokableDefinitions.map((id) => {
    const definition = catalog.get(definitionRef(id)) as AnyDefinition;
    const stock = definition.kind === "agent" && definition.sessionMode === "stock";
    return {
      definitionId: definition.id,
      kind: stock ? "session" : definition.kind,
      title: definition.title,
      description: definition.description,
      inputSchema: definition.input.id,
      outputSchema: stock ? "dynamic" : definition.output.id,
    };
  });
}

function definitionForRoute(route: DispatchRoute): DefinitionRef<unknown, unknown> {
  if (route === "qa") return definitionRef(WORKFLOW_QA);
  if (route === "implement") return definitionRef(WORKFLOW_IMPLEMENT);
  return definitionRef(AGENT_COORDINATOR);
}

function describeOutcome(outcome: Outcome<unknown>): string {
  if (outcome.status === "failure") return outcome.failure.message;
  if (outcome.status === "cancelled") return outcome.reason;
  return "unexpected successful outcome";
}
