import type { DispatchDecision, DispatchRoute } from "../definitions/dispatch.ts";
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
import type { Outcome, RunId } from "../domain/shared.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { CatalogFacade, ExecutionFacade } from "./interfaces.ts";
import type { InvocationPolicy } from "./invocation-policy.ts";

export type DispatchMode = "auto" | DispatchRoute;

export interface DispatchRequest extends ObjectiveRequest {
  readonly mode?: DispatchMode;
  readonly wait?: "await" | "background";
}

export interface DispatchResult {
  readonly route: DispatchRoute;
  readonly definition: string;
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
    let route = explicit ?? classifyDeterministicDispatch(objective);
    let classifierRunId: RunId | undefined;

    if (!route) {
      const classifierRef = definitionRef(AGENT_DISPATCHER);
      this.assertAllowed(parentId, this.catalog.get(classifierRef) as AnyDefinition, {
        objective,
        ...(request.context === undefined ? {} : { context: request.context }),
      });
      const classifier = await this.execution.start({
        parentId,
        definition: classifierRef,
        input: {
          objective,
          ...(request.context === undefined ? {} : { context: request.context }),
        },
        wait: "await",
      });
      classifierRunId = classifier.id;
      const decision = await classifier.result(signal);
      if (decision.status !== "success") {
        throw new Error(`Dispatch classifier failed: ${describeOutcome(decision)}`);
      }
      route = (decision.value as DispatchDecision).route;
    }

    const targetRef = definitionForRoute(route);
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
        route,
        definition: targetRef.id,
        runId: handle.id,
        ...(classifierRunId ? { classifierRunId } : {}),
        status: "running",
      };
    }

    return {
      route,
      definition: targetRef.id,
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

export function classifyDeterministicDispatch(objective: string): DispatchRoute | undefined {
  const normalized = objective.toLowerCase();
  const qa = /\b(qa|quality assurance|audit|review|validate|verification|check(?:s|ing)?)\b/.test(
    normalized,
  );
  const mutate =
    /\b(fix|implement|change|modify|add|remove|refactor|update|rewrite|migrate|build|create|apply|address)\b/.test(
      normalized,
    );

  if (qa && mutate) return "coordinate";
  if (qa) return "qa";
  if (mutate) return "implement";
  return undefined;
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
