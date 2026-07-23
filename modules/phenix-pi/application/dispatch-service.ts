import type {
  DispatchCandidate,
  DispatchDecision,
  DispatchRoute,
} from "../definitions/dispatch.ts";
import {
  AGENT_COORDINATOR,
  AGENT_DISPATCHER,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_QA,
} from "../definitions/ids.ts";
import type { ObjectiveRequest } from "../definitions/schemas.ts";
import {
  type AnyDefinition,
  type DefinitionRef,
  definitionRef,
} from "../domain/definition/definition.ts";
import type { DefinitionId, Outcome, RunId } from "../domain/shared.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { CatalogFacade, DefinitionSummary, ExecutionFacade } from "./interfaces.ts";
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
  readonly status: "running" | "completed";
  readonly outcome?: Outcome<unknown>;
}

export class DispatchService {
  private readonly execution: ExecutionFacade;
  private readonly catalog: CatalogFacade;
  private readonly store: ExecutionStore;
  private readonly invocationPolicy: InvocationPolicy;

  constructor(input: {
    readonly execution: ExecutionFacade;
    readonly catalog: CatalogFacade;
    readonly store: ExecutionStore;
    readonly invocationPolicy: InvocationPolicy;
  }) {
    this.execution = input.execution;
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
        throw new Error("No workflow or generic coordinator is available for dispatch");
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
    this.assertAllowed(parentId, this.catalog.get(targetRef) as AnyDefinition, input);

    const wait = request.wait ?? "await";
    const handle = await this.execution.start({
      parentId,
      definition: targetRef,
      input,
      wait,
    });
    if (wait === "background") {
      return {
        definition: targetRef.id,
        selectedBy,
        runId: handle.id,
        ...(classifierRunId ? { classifierRunId } : {}),
        status: "running",
      };
    }

    return {
      definition: targetRef.id,
      selectedBy,
      runId: handle.id,
      ...(classifierRunId ? { classifierRunId } : {}),
      status: "completed",
      outcome: await handle.result(signal),
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
