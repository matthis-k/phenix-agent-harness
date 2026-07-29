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
  SESSION_STOCK,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_QA,
} from "../definitions/ids.ts";
import {
  BaseResultSchema,
  type ObjectiveRequest,
  ObjectiveRequestSchema,
} from "../definitions/schemas.ts";
import {
  type StockSessionHandoff,
  StockSessionHandoffSchema,
  type StockSessionRequest,
} from "../definitions/stock-session.ts";
import {
  type AgentDefinition,
  type AnyDefinition,
  type DefinitionRef,
  definitionRef,
} from "../domain/definition/definition.ts";
import { failed, type DefinitionId, type Outcome, type RunId, success } from "../domain/shared.ts";
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

    const explicit = request.mode && request.mode !== "auto" ? request.mode : undefined;
    let targetRef: DefinitionRef<unknown, unknown>;
    let classifierRunId: RunId | undefined;
    let selectedBy: DispatchResult["selectedBy"];

    if (explicit) {
      targetRef = definitionForRoute(explicit);
      selectedBy = "explicit";
    } else {
      const candidates = selectDispatchCandidates(await this.catalog.listAvailable(parentId));
      if (candidates.length === 0) {
        throw new Error("No workflow, stock session, or dynamic composer is available for dispatch");
      }

      const classifierRef = definitionRef(AGENT_DISPATCHER);
      const classifierInput = {
        objective,
        ...(request.context === undefined ? {} : { context: request.context }),
        candidates,
      };
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
      classifierRunId = classifier.id;
      const decision = await classifier.result(signal);
      if (decision.status !== "success") {
        throw new Error(`Dispatch selector failed: ${describeOutcome(decision)}`);
      }
      const selected = requireSelectedCandidate(candidates, decision.value as DispatchDecision);
      targetRef = definitionRef(selected.definitionId);
      selectedBy = "dispatcher";
    }

    const input = {
      objective,
      ...(request.context === undefined ? {} : { context: request.context }),
    };
    if (targetRef.id === AGENT_COORDINATOR) {
      return this.compose(
        parentId,
        input,
        request.wait ?? "await",
        selectedBy,
        classifierRunId,
        signal,
      );
    }
    if (targetRef.id === SESSION_STOCK) {
      return this.dispatchStock(
        parentId,
        input,
        request.wait ?? "await",
        selectedBy,
        classifierRunId,
        signal,
      );
    }

    this.assertAllowed(parentId, this.catalog.get(targetRef) as AnyDefinition, input);
    const handle = await this.execution.start({
      parentId,
      definition: targetRef,
      input,
      wait: request.wait ?? "await",
    });
    return this.resultForHandle({
      handle,
      definition: targetRef.id,
      selectedBy,
      classifierRunId,
      wait: request.wait ?? "await",
      signal,
    });
  }

  private async dispatchStock(
    parentId: RunId,
    input: ObjectiveRequest,
    wait: "await" | "background",
    selectedBy: DispatchResult["selectedBy"],
    classifierRunId: RunId | undefined,
    signal: AbortSignal | undefined,
  ): Promise<DispatchResult> {
    const stockRef = definitionRef<StockSessionRequest, StockSessionHandoff>(SESSION_STOCK);
    const stockInput: StockSessionRequest = {
      task: input.objective,
      ...(input.context === undefined ? {} : { context: input.context }),
      outputSchema: BaseResultSchema.id,
      outputContract: BaseResultSchema.jsonSchema,
    };
    this.assertAllowed(parentId, this.catalog.get(stockRef) as AnyDefinition, stockInput);
    const handle = await this.execution.start({
      parentId,
      definition: stockRef,
      input: stockInput,
      wait,
    });
    return this.resultForHandle({
      handle,
      definition: SESSION_STOCK,
      selectedBy,
      classifierRunId,
      wait,
      signal,
      mapOutcome: unwrapStockOutcome,
    });
  }

  private async compose(
    parentId: RunId,
    input: ObjectiveRequest,
    wait: "await" | "background",
    selectedBy: DispatchResult["selectedBy"],
    classifierRunId: RunId | undefined,
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
      selectedBy,
      classifierRunId,
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
    readonly wait: "await" | "background";
    readonly signal?: AbortSignal;
    readonly mapOutcome?: (outcome: Outcome<unknown>) => Outcome<unknown>;
  }): Promise<DispatchResult> {
    if (input.wait === "background") {
      return {
        definition: input.definition,
        selectedBy: input.selectedBy,
        runId: input.handle.id,
        ...(input.classifierRunId ? { classifierRunId: input.classifierRunId } : {}),
        ...(input.composerRunId ? { composerRunId: input.composerRunId } : {}),
        status: "running",
      };
    }

    const settled = await awaitOutcomeOrBudget({
      store: this.store,
      runId: input.handle.id,
      signal: input.signal,
    });
    if (settled.status === "suspended") {
      return {
        definition: input.definition,
        selectedBy: input.selectedBy,
        runId: input.handle.id,
        ...(input.classifierRunId ? { classifierRunId: input.classifierRunId } : {}),
        ...(input.composerRunId ? { composerRunId: input.composerRunId } : {}),
        status: "suspended",
        suspension: settled.suspension,
      };
    }
    return {
      definition: input.definition,
      selectedBy: input.selectedBy,
      runId: input.handle.id,
      ...(input.classifierRunId ? { classifierRunId: input.classifierRunId } : {}),
      ...(input.composerRunId ? { composerRunId: input.composerRunId } : {}),
      status: "completed",
      outcome: input.mapOutcome ? input.mapOutcome(settled.outcome) : settled.outcome,
    };
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
    .filter(
      (definition) =>
        definition.kind === "workflow" ||
        definition.id === SESSION_STOCK ||
        definition.id === AGENT_COORDINATOR,
    )
    .map((definition) => ({
      definitionId: definition.id,
      kind:
        definition.kind === "workflow"
          ? "workflow"
          : definition.id === SESSION_STOCK
            ? "session"
            : "generic",
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

function unwrapStockOutcome(outcome: Outcome<unknown>): Outcome<unknown> {
  if (outcome.status !== "success") return outcome;
  const handoff = StockSessionHandoffSchema.validate(outcome.value);
  if (!handoff.ok) {
    return failed({
      code: "output_invalid",
      message: `Stock session returned an invalid handoff: ${handoff.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
      retryable: false,
    });
  }
  if (handoff.value.outputSchema !== BaseResultSchema.id) {
    return failed({
      code: "output_invalid",
      message: `Stock session returned schema ${handoff.value.outputSchema} instead of ${BaseResultSchema.id}`,
      retryable: false,
    });
  }
  const value = BaseResultSchema.validate(handoff.value.value);
  if (!value.ok) {
    return failed({
      code: "output_invalid",
      message: `Stock session output is invalid: ${value.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
      retryable: false,
    });
  }
  return success(value.value);
}

function describeOutcome(outcome: Outcome<unknown>): string {
  if (outcome.status === "failure") return outcome.failure.message;
  if (outcome.status === "cancelled") return outcome.reason;
  return "unexpected successful outcome";
}
