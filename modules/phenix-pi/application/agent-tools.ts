import { Type } from "typebox";

import { type AnyDefinition, definitionRef } from "../domain/definition/definition.ts";
import { defineSchema, type Schema } from "../domain/definition/schema.ts";
import { definitionId, type Outcome, type RunId, runId } from "../domain/shared.ts";
import type { AgentTool, AgentToolResult } from "../ports/agent-session-backend.ts";
import {
  awaitOutcomeOrBudget,
  type BudgetSuspension,
  encodeBudgetResumeControl,
  pendingBudgetSuspension,
  pendingBudgetSuspensionInScope,
} from "./budget-suspension.ts";
import type { DispatchService } from "./dispatch-service.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { CatalogFacade, ExecutionFacade } from "./interfaces.ts";
import { allowAllInvocations, type InvocationPolicy } from "./invocation-policy.ts";
import { PresentationRequestSchema, presentationFact } from "./presentation.ts";
import {
  presentRootResult,
  type ResultPresentationRequest,
  type ResultRenderer,
  type ResultTransform,
} from "./result-presentation.ts";
import {
  projectCompletedRun,
  projectDispatchResult,
  projectedToolResult,
  projectOutcome,
  projectRetryResult,
  projectRunSnapshot,
  type RunResultView,
} from "./tool-result-projection.ts";

export interface AgentToolFactory {
  forRun(runId: RunId): Promise<readonly AgentTool[]>;
}

const resultPresentationProperties = {
  transform: Type.Optional(
    Type.Enum(["auto", "qa-report", "mermaid-source"], {
      description:
        "Named transform from completed contract data into typed renderer input. auto currently selects qa-report only when the QA contract shape is present.",
    }),
  ),
  renderer: Type.Optional(
    Type.Enum(["auto", "tool", "pi-markdown", "beautiful-mermaid"], {
      description:
        "Renderer for transformed output. auto selects pi-markdown for Markdown and beautiful-mermaid for Mermaid; tool keeps the transformed source in the ordinary tool result.",
    }),
  ),
} as const;

const runParameters = defineSchema<{
  definition: string;
  input: unknown;
  wait?: "await" | "background";
}>(
  "tool.phenix-run",
  Type.Object({
    definition: Type.String({ description: "Definition ID from the available Phenix catalog" }),
    input: Type.Unknown({ description: "Input matching the selected definition schema" }),
    wait: Type.Optional(Type.Enum(["await", "background"])),
  }),
);

const dispatchParameters = defineSchema<{
  objective: string;
  context?: unknown;
  mode?: "auto" | "qa" | "implement" | "coordinate";
  wait?: "await" | "background";
  transform?: ResultTransform;
  renderer?: ResultRenderer;
}>(
  "tool.phenix-dispatch",
  Type.Object({
    objective: Type.String({ minLength: 1 }),
    context: Type.Optional(Type.Unknown()),
    mode: Type.Optional(Type.Enum(["auto", "qa", "implement", "coordinate"])),
    wait: Type.Optional(Type.Enum(["await", "background"])),
    ...resultPresentationProperties,
  }),
);

const handleParameters = defineSchema<{
  action: "inspect" | "await" | "send" | "cancel" | "retry" | "resume";
  runId: string;
  message?: string;
  wait?: "await" | "background";
  view?: RunResultView;
  transform?: ResultTransform;
  renderer?: ResultRenderer;
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
    action: Type.Enum(["inspect", "await", "send", "cancel", "retry", "resume"]),
    runId: Type.String(),
    message: Type.Optional(Type.String()),
    wait: Type.Optional(Type.Enum(["await", "background"])),
    view: Type.Optional(Type.Enum(["summary", "outcome", "failure", "full"])),
    ...resultPresentationProperties,
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

export class FacadeAgentToolFactory implements AgentToolFactory {
  private readonly execution: ExecutionFacade;
  private readonly dispatch?: DispatchService;
  private readonly catalog: CatalogFacade;
  private readonly store: ExecutionStore;
  private readonly invocationPolicy: InvocationPolicy;

  constructor(input: {
    readonly execution: ExecutionFacade;
    readonly dispatch?: DispatchService;
    readonly catalog: CatalogFacade;
    readonly store: ExecutionStore;
    readonly invocationPolicy?: InvocationPolicy;
  }) {
    this.execution = input.execution;
    this.dispatch = input.dispatch;
    this.catalog = input.catalog;
    this.store = input.store;
    this.invocationPolicy = input.invocationPolicy ?? allowAllInvocations;
  }

  async forRun(parentId: RunId): Promise<readonly AgentTool[]> {
    const parent = this.store.projection.requireRun(parentId);
    const available = await this.catalog.listAvailable(parentId);
    const completionResult = (
      result: AgentToolResult,
      presentation: ResultPresentationRequest,
    ): AgentToolResult =>
      parent.kind === "root" ? presentRootResult(result, presentation) : result;
    const runTool: AgentTool = {
      name: "phenix_run",
      label: "Phenix Run",
      description: `Invoke one typed agent or workflow definition. Available: ${
        available.map((definition) => definition.id).join(", ") || "none"
      }. Awaited calls return either a compact result or a budget suspension identifying the same child session that may be resumed through phenix_handle.`,
      parameters: runParameters,
      execute: async (raw, signal) => {
        const params = requireValid(runParameters, raw);
        const ref = definitionRef(definitionId(params.definition));
        const currentParent = this.store.projection.requireRun(parentId);
        this.invocationPolicy.assertAllowed({
          rootRunId: this.store.projection.rootOf(parentId),
          parent: currentParent,
          definition: this.catalog.get(ref) as AnyDefinition,
          input: params.input,
        });
        const handle = await this.execution.start({
          parentId,
          definition: ref,
          input: params.input,
          wait: params.wait ?? "await",
        });
        if ((params.wait ?? "await") === "background") {
          return projectedToolResult({ runId: handle.id, status: "running" });
        }
        const settled = await awaitOutcomeOrBudget({
          store: this.store,
          runId: handle.id,
          signal,
        });
        if (settled.status === "suspended") {
          return projectedToolResult(
            projectBudgetSuspension(handle.id, settled.suspension),
            settled.suspension,
          );
        }
        return projectedToolResult(
          projectCompletedRun(handle.id, settled.outcome),
          settled.outcome,
        );
      },
    };

    const dispatchTool: AgentTool = {
      name: "phenix_dispatch",
      label: "Phenix Dispatch",
      description:
        "Route substantial work through a mandatory catalog-driven selector. Use auto for normal requests; explicit qa, implement, or coordinate modes are operator overrides only. Awaited results may apply a named contract transform and renderer. For example, transform=qa-report with renderer=pi-markdown deterministically renders the QA contract directly without frontend synthesis.",
      parameters: dispatchParameters,
      execute: async (raw, signal) => {
        const params = requireValid(dispatchParameters, raw);
        if (!this.dispatch) throw new Error("Root dispatch service is not configured");
        const result = await this.dispatch.dispatch(parentId, params, signal);
        if (result.status === "suspended" && result.suspension) {
          return projectedToolResult(
            {
              definition: result.definition,
              selectedBy: result.selectedBy,
              runId: result.runId,
              ...(result.classifierRunId ? { classifierRunId: result.classifierRunId } : {}),
              ...projectBudgetSuspension(result.runId, result.suspension),
            },
            result,
          );
        }
        return completionResult(projectedToolResult(projectDispatchResult(result), result), params);
      },
    };

    const handleTool: AgentTool = {
      name: "phenix_handle",
      label: "Phenix Handle",
      description:
        "Inspect, await, message, resume, cancel, or retry an accessible run. Resume increases limits on the same budget-suspended Pi session and preserves its context. Retry is reserved for creating a linked replacement run after a terminal non-budget failure. Completed inspect, await, resume, and retry results accept the same transform and renderer pipeline as phenix_dispatch.",
      parameters: handleParameters,
      execute: async (raw, signal) => {
        const params = requireValid(handleParameters, raw);
        const targetId = runId(params.runId);
        this.assertAccessible(parentId, targetId);
        if (targetId === parentId && params.action !== "inspect") {
          throw new Error(`A run cannot control its own lifecycle through phenix_handle`);
        }
        if (params.action === "inspect") {
          const snapshot = await this.execution.inspect(targetId);
          const projected = projectRunSnapshot(snapshot, params.view);
          const suspension = pendingBudgetSuspensionInScope(this.store, targetId);
          return completionResult(
            projectedToolResult(
              suspension
                ? {
                    ...asRecord(projected),
                    suspension: projectBudgetSuspension(targetId, suspension).suspension,
                  }
                : projected,
              snapshot,
            ),
            params,
          );
        }
        if (params.action === "await") {
          const settled = await awaitOutcomeOrBudget({
            store: this.store,
            runId: targetId,
            signal,
          });
          if (settled.status === "suspended") {
            return projectedToolResult(
              projectBudgetSuspension(targetId, settled.suspension),
              settled.suspension,
            );
          }
          return completionResult(
            projectedToolResult(
              projectOutcomeForView(settled.outcome, params.view),
              settled.outcome,
            ),
            params,
          );
        }
        if (params.action === "resume") {
          const caller = this.store.projection.requireRun(parentId);
          if (caller.kind !== "root" && !caller.compiled.capabilities.maySend) {
            throw new Error(`Run ${parentId} may not resume child sessions`);
          }
          const suspension = pendingBudgetSuspension(this.store, targetId);
          if (!suspension) throw new Error(`Run ${targetId} has no pending budget suspension`);
          const wait = params.wait ?? "await";
          await this.execution.send(
            targetId,
            encodeBudgetResumeControl({
              ...(params.limits ? { limits: params.limits } : {}),
              ...(params.message?.trim() ? { message: params.message.trim() } : {}),
            }),
            signal,
          );
          if (wait === "background") {
            return projectedToolResult({
              runId: targetId,
              status: "running",
              resumed: true,
              sameSession: true,
              previousSuspension: projectBudgetSuspension(targetId, suspension).suspension,
            });
          }
          const settled = await awaitOutcomeOrBudget({
            store: this.store,
            runId: targetId,
            signal,
          });
          if (settled.status === "suspended") {
            return projectedToolResult(
              {
                resumed: true,
                sameSession: true,
                ...projectBudgetSuspension(targetId, settled.suspension),
              },
              settled.suspension,
            );
          }
          const projected = projectOutcomeForView(settled.outcome, params.view);
          return completionResult(
            projectedToolResult(
              { runId: targetId, resumed: true, sameSession: true, outcome: projected },
              settled.outcome,
            ),
            params,
          );
        }
        if (params.action === "retry") {
          const wait = params.wait ?? "await";
          const handle = await this.execution.retry(parentId, targetId, {
            wait,
            ...(params.addTools ? { addTools: params.addTools } : {}),
            ...(params.limits ? { limits: params.limits } : {}),
          });
          if (wait === "background") {
            return projectedToolResult({ runId: handle.id, retryOf: targetId, status: "running" });
          }
          const settled = await awaitOutcomeOrBudget({
            store: this.store,
            runId: handle.id,
            signal,
          });
          if (settled.status === "suspended") {
            return projectedToolResult(
              {
                retryOf: targetId,
                ...projectBudgetSuspension(handle.id, settled.suspension),
              },
              settled.suspension,
            );
          }
          const outcome = settled.outcome;
          const projected =
            params.view === "outcome" || params.view === "full"
              ? { runId: handle.id, retryOf: targetId, outcome }
              : params.view === "failure" && outcome.status === "failure"
                ? { runId: handle.id, retryOf: targetId, failure: outcome.failure }
                : projectRetryResult(handle.id, targetId, outcome);
          return completionResult(
            projectedToolResult(projected, { runId: handle.id, retryOf: targetId, outcome }),
            params,
          );
        }
        const caller = this.store.projection.requireRun(parentId);
        if (params.action === "send") {
          if (!caller.compiled.capabilities.maySend) {
            throw new Error(`Run ${parentId} may not send child messages`);
          }
          if (!params.message?.trim()) throw new Error(`send requires message`);
          await this.execution.send(targetId, params.message, signal);
          return { text: `Message sent to ${targetId}.` };
        }
        if (!caller.compiled.capabilities.mayCancelChildren) {
          throw new Error(`Run ${parentId} may not cancel children`);
        }
        await this.execution.cancel(
          targetId,
          params.message?.trim() || "Cancelled by parent agent",
        );
        return { text: `Cancellation requested for ${targetId}.` };
      },
    };

    const presentTool: AgentTool = {
      name: "phenix_present",
      label: "Phenix Present",
      description:
        "Publish one bounded warning, high-severity, or critical finding directly to the user and root model. Use only for material issues that should be visible before this run completes; use phenix_progress for ordinary status.",
      parameters: PresentationRequestSchema,
      execute: async (raw) => {
        const request = requireValid(PresentationRequestSchema, raw);
        const fact = presentationFact(parentId, request);
        const presentationId = String(fact.details?.presentationId);
        const duplicate = this.store.projection.facts.some(
          (existing) => existing.details?.presentationId === presentationId,
        );
        if (!duplicate) {
          await this.store.commit(this.store.projection.rootOf(parentId), [
            { runId: parentId, type: "run.fact.recorded", data: fact },
          ]);
        }
        return projectedToolResult({
          presented: !duplicate,
          duplicate,
          presentationId,
          severity: request.severity,
          sourceRunId: parentId,
        });
      },
    };

    return parent.kind === "root"
      ? [dispatchTool, handleTool]
      : [runTool, handleTool, presentTool];
  }

  private assertAccessible(callerId: RunId, targetId: RunId): void {
    const caller = this.store.projection.requireRun(callerId);
    let target = this.store.projection.requireRun(targetId);
    if (caller.kind === "root" && this.store.projection.rootOf(target.id) === caller.id) return;
    while (target.parentId) {
      if (target.parentId === caller.id) return;
      target = this.store.projection.requireRun(target.parentId);
    }
    throw new Error(`Run ${targetId} is outside caller ${callerId}'s run scope`);
  }
}

function projectBudgetSuspension(
  scopeRunId: RunId,
  suspension: BudgetSuspension,
): Readonly<Record<string, unknown>> {
  return {
    runId: scopeRunId,
    status: "suspended",
    suspension: {
      runId: suspension.runId,
      reason: suspension.failure.message,
      failure: suspension.failure,
      sameSession: true,
      currentLimits: suspension.currentLimits,
      suggestedLimits: suspension.suggestedLimits,
      counters: {
        turns: suspension.turnCount,
        toolCalls: suspension.toolCallCount,
      },
      timeoutRemainingMs: suspension.timeoutRemainingMs,
    },
    nextAction: {
      tool: "phenix_handle",
      action: "resume",
      runId: suspension.runId,
      note: "Omit limits to accept suggestedLimits, or supply larger limits. Resume preserves the existing Pi session and context.",
    },
  };
}

function projectOutcomeForView(
  outcome: Outcome<unknown>,
  view: RunResultView | undefined,
): unknown {
  if (view === "outcome" || view === "full") return outcome;
  return projectOutcome(outcome, view ?? "summary");
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : { value };
}

function requireValid<T>(schema: Schema<T>, value: unknown): T {
  const validation = schema.validate(value);
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
  }
  return validation.value;
}
