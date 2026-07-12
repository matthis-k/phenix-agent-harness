import { randomUUID } from "node:crypto";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  resolveChildSpec,
  type ResolvedChildSpec,
  type ContractCreatorContext,
  type ResolvedWorkflowChildInput,
} from "./child-spec.ts";
import {
  SubagentBackend,
} from "./backend.ts";
import {
  runAttempt,
} from "./attempt-runner.ts";
import {
  type HandleRecord,
  HANDLE_VERSION,
  TERMINAL_STATES,
  type WorkflowBinding,
} from "./handle-types.ts";
import {
  writeRecord,
  readRecord,
  listRecords,
  latestAttempt,
  effectiveSessionId,
  now,
} from "./handle-store.ts";
import type { Details } from "pi-subagents/src/shared/types.ts";
import {
  DelegateParams,
  AgentParams,
} from "./delegate-schema.ts";
import {
  getRuntimeContext,
} from "./contract-runtime-context.ts";
import { toolAllowedByConfig } from "./tool-policy.ts";

// ── Workflow imports ──────────────────────────────────────────────────────

import type {
  WorkflowTransitionId,
} from "../phenix-workflow/workflow-types.ts";
import type { TransitionAuthority } from "../phenix-workflow/transition-authority.ts";
import type { Difficulty } from "../phenix-routing/types.ts";
import { PHENIX_DEFAULT_WORKFLOW, buildWorkflowRuntimeDependencies, buildWorkflowDecisionContext, getOutputSchema } from "../phenix-workflow/index.ts";
import {
  readWorkflowRecord,
  beginTransition,
  createWorkflowRecord,
  WorkflowStoreError,
} from "../phenix-workflow/workflow-store.ts";
import {
  finalizeHandleWorkflow,
} from "../phenix-workflow/workflow-runtime.ts";

import type { AgentRole } from "./agent-types.ts";

// ── Types ───────────────────────────────────────────────────────────────────

interface PiEvents {
  on(event: string, handler: (payload: unknown) => void): (() => void) | void;
  emit(event: string, payload: unknown): void;
}

// ── Tool result helpers ─────────────────────────────────────────────────────

function toolResult(
  record: HandleRecord,
): AgentToolResult<Record<string, unknown>> {
  const attempt = latestAttempt(record);
  const min = {
    id: record.id,
    handleId: record.id,
    runId: attempt?.runId,
    status: record.status,
    value: record.value,
    error: record.errors?.join(" | "),
    ...(record.producerSpec ? {
      role: record.producerSpec.role,
      agent: record.producerSpec.agent,
      model: record.producerSpec.model,
      thinking: record.producerSpec.thinking,
      tier: record.producerSpec.tier,
    } : {}),
  };
  const compact = JSON.stringify(min, null, 2);
  return {
    content: [
      {
        type: "text",
        text:
          compact.length > 500
            ? `${compact.slice(0, 497)}...`
            : compact,
      },
    ],
    details: min as Record<string, unknown>,
  };
}

function errorResult(
  message: string,
  details?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: details ?? { status: "failed" },
  };
}

// ── Tree payload ────────────────────────────────────────────────────────────

function treePayload(
  records: HandleRecord[],
): Record<string, unknown> {
  return {
    handles: records.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      status: r.status,
      role: r.producerSpec.role,
      agent: r.producerSpec.agent,
      attempts: r.attempts.length,
    })),
  };
}

// ── Handle lifecycle ────────────────────────────────────────────────────────

function createHandle(
  ctx: ExtensionContext,
  producerSpec: ResolvedChildSpec,
  criticSpec: ResolvedChildSpec | undefined,
  task: string,
  requirements: readonly string[],
  outputSchema: Record<string, unknown>,
  parentId?: string,
  workflowBinding?: WorkflowBinding,
): HandleRecord {
  return {
    version: HANDLE_VERSION,
    id: randomUUID(),
    sessionId: effectiveSessionId(ctx),
    parentId,
    assignment: {
      task,
      requirements: [...requirements],
      outputSchema,
    },
    producerSpec,
    ...(criticSpec ? { criticSpec } : {}),
    ...(workflowBinding ? { workflowBinding } : {}),
    createdAt: now(),
    updatedAt: now(),
    status: "running",
    attempts: [],
  };
}

// ── Handle resolution for await/poll ────────────────────────────────────────

async function resolveBackground(
  backend: SubagentBackend,
  ctx: ExtensionContext,
  signal: AbortSignal,
  record: HandleRecord,
  awaitCompletion: boolean,
): Promise<HandleRecord> {
  // Already terminal — nothing to do.
  if (TERMINAL_STATES.has(record.status)) return record;

  const attempt = latestAttempt(record);
  if (attempt.status !== "running") {
    // Check if there's a pending attempt that's still running.
    const lastAttempt = record.attempts.at(-1);
    if (!lastAttempt || lastAttempt.status !== "running") return record;
  }

  if (!awaitCompletion) {
    // Just poll once — check if result file exists.
    const attempt = latestAttempt(record);
    if (!attempt.asyncDir) return record;
    try {
      const result = backend.readResult(attempt.runId);
      if (!result) return record;
    } catch {
      return record;
    }
  }

  // Run the full attempt runner (idempotent — will skip completed/cancelled).
  const runnerResult = await runAttempt(backend, ctx, signal, record);
  return runnerResult.record;
}

// ── Extension entry point ───────────────────────────────────────────────────

export default async function phenixSubagents(
  pi: ExtensionAPI,
): Promise<void> {
  const events = pi.events as unknown as PiEvents;
  const backend = new SubagentBackend(pi);

  // ── Runtime tool guard ────────────────────────────────────────────────

  // Block raw subagent and obsolete contract tools globally.
  events.on("before_tool_call" as string, async (event: unknown) => {
    const raw = event as { toolName?: string; name?: string };
    const toolName = raw.toolName ?? raw.name;
    if (!toolName) return;

    // Always block raw subagent.
    if (toolName === "subagent") {
      return {
        blocked: true,
        reason:
          "Raw subagent calls are runtime-blocked in Phenix sessions. Use phenix_delegate instead.",
      };
    }

    // Block obsolete contract tools.
    if (
      toolName === "phenix_contract_get" ||
      toolName === "phenix_contract_submit"
    ) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" is no longer available. Use phenix_complete to submit your result.`,
      };
    }

    // In child session, enforce contract tool authorization.
    const runtimeCtx = getRuntimeContext();
    if (runtimeCtx?.kind === "child") {
      const contract = runtimeCtx.contract;

      // phenix_complete is always allowed for child sessions.
      if (toolName === "phenix_complete") return;

      if (!toolAllowedByConfig(contract.runtime.tools, toolName)) {
        return {
          blocked: true,
          reason:
            `Tool "${toolName}" is not authorized by the active Phenix contract.`,
        };
      }
    }
  });

  // ── phenix_delegate tool ──────────────────────────────────────────────

  pi.registerTool({
    name: "phenix_delegate",
    label: "Delegate Phenix Subagent",
    description:
      "Spawn a real isolated Pi subagent with a runtime-selected model and thinking level. The output schema is enforced by the Phenix contract protocol. Tool access, verification commands, critic gates, retry limits, persistence, and model routing are runtime-owned; this tool intentionally exposes no override for them. Use mode=await by default. Background mode is available only from the root session and returns a persistent handle.",
    parameters: DelegateParams,

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal,
      _onUpdate:
        | ((result: AgentToolResult<Details>) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      try {
        const params = rawParams as {
          transitionId: string;
          workflowRevision: number;
          authorityDigest?: string;
          task: string;
          requirements?: string[];
          tools?: {
            additional?: string[];
            removed?: string[];
          } | null;
          delegateRoles?: {
            additional?: string[];
            removed?: string[];
          } | null;
          mode?: "await" | "background";
        };

        // ── Validate required params ──────────────────────────────────

        if (typeof params.transitionId !== "string" || params.transitionId.length === 0) {
          return errorResult("phenix_delegate: transitionId is required. Select one from the projected delegation options.");
        }
        if (typeof params.workflowRevision !== "number") {
          return errorResult("phenix_delegate: workflowRevision is required. Copy the revision from the projected delegation options.");
        }
        if (typeof params.task !== "string" || params.task.length === 0) {
          return errorResult("phenix_delegate: task is required.");
        }

        const requirements = params.requirements ?? [];
        const isBackground = params.mode === "background";

        // ── Build shared runtime dependencies ───────────────────────

        const sessionId = effectiveSessionId(ctx);
        const runtimeCtx = getRuntimeContext();

        const source =
          runtimeCtx?.kind === "child"
            ? {
                kind: "child" as const,
                contract: runtimeCtx.contract,
              }
            : {
                kind: "root" as const,
                sessionId,
              };

        const dependencies = buildWorkflowRuntimeDependencies({
          cwd: ctx.cwd,
          sessionId,
          source,
        });

        let wfRecord = dependencies.record;

        const decision = buildWorkflowDecisionContext({
          definition: dependencies.definition,
          runtime: dependencies.record,
          authority: dependencies.authority,
          activeHandles: dependencies.activeHandles,
        });

        // ── Validate authority digest ─────────────────────────────

        if (
          typeof params.authorityDigest === "string" &&
          params.authorityDigest !== decision.optionsDigest
        ) {
          return errorResult(
            "phenix_delegate: stale workflow authority digest.",
            {
              code: "STALE_WORKFLOW_AUTHORITY",
              expected: decision.optionsDigest,
              received: params.authorityDigest,
              state: decision.currentState,
              revision: decision.revision,
            },
          );
        }

        // ── Validate revision ─────────────────────────────────────

        if (params.workflowRevision !== wfRecord.revision) {
          return errorResult(
            `phenix_delegate: stale workflow revision. Expected ${params.workflowRevision}, current ${wfRecord.revision}. ` +
            `Current state: ${wfRecord.state}. Refresh delegation options before attempting again.`,
            { currentState: wfRecord.state, currentRevision: wfRecord.revision },
          );
        }

        // ── Validate transition against decision context ──────────

        const transitionId = params.transitionId as WorkflowTransitionId;
        const matchingOption = decision.options.find(
          (o) => o.transitionId === transitionId,
        );

        if (!matchingOption) {
          const availableIds = decision.options.map((o) => o.transitionId).join(", ");
          return errorResult(
            `phenix_delegate: transition "${params.transitionId}" is not currently available. ` +
            `State: ${wfRecord.state}, Difficulty: ${wfRecord.difficulty}. ` +
            `Available transitions: ${availableIds || "(none)"}`,
            {
              state: wfRecord.state,
              difficulty: wfRecord.difficulty,
              available: decision.options.map((o) => ({
                id: o.transitionId,
                role: o.role,
                category: o.category,
              })),
            },
          );
        }

        // ── Validate mode ─────────────────────────────────────────

        if (isBackground && !matchingOption.allowedModes.includes("background")) {
          return errorResult(
            `phenix_delegate: background mode is not allowed for transition "${params.transitionId}". ` +
            `Allowed modes: ${matchingOption.allowedModes.join(", ")}.`,
          );
        }

        // ── Look up transition definition ─────────────────────────

        const transition = PHENIX_DEFAULT_WORKFLOW.transitions.find(
          (t) => t.id === transitionId,
        );
        if (!transition) {
          return errorResult(`phenix_delegate: internal error - transition "${params.transitionId}" not found in workflow definition.`);
        }
        if (transition.kind !== "delegate") {
          return errorResult(`phenix_delegate: internal error - "${params.transitionId}" is not a delegate transition.`);
        }

        // ── Create handle and child actor IDs before transition ───

        const handleId = randomUUID();
        const childActorId = `actor_${handleId}`;
        const instanceId = wfRecord.instanceId;

        // ── Begin workflow transition ──────────────────
        // Capture source state before transition.
        const sourceStateBefore = wfRecord.state;
        const sourceRevisionBefore = wfRecord.revision;

        let executionId: string;
        try {
          const result = beginTransition(ctx.cwd, wfRecord, {
            expectedRevision: sourceRevisionBefore,
            transitionId: transition.id,
            handleId,
          });
          wfRecord = result.record;
          executionId = result.executionId;
        } catch (err) {
          if (err instanceof WorkflowStoreError) {
            return errorResult(
              `phenix_delegate: workflow error [${err.code}]: ${err.message}`,
              { code: err.code, ...err.context } as Record<string, unknown>,
            );
          }
          throw err;
        }

        // ── Create child actor workflow record before spawn ───────

        const childInitialState = transition.role === null
          ? "classified"
          : (transition.role === "scout" ? "scouting" :
             transition.role === "planner" ? "planning" :
             transition.role === "architect" ? "designing" :
             transition.role === "implementer" ? "implementing" :
             transition.role === "tester" ? "testing" :
             transition.role === "critic" ? "reviewing" : "finalizing") as import("../phenix-workflow/workflow-types.ts").WorkflowStateId;

        createWorkflowRecord(ctx.cwd, {
          instanceId,
          actorId: childActorId,
          parentActorId: wfRecord.actorId,
          sessionId,
          definitionId: wfRecord.definitionId,
          difficulty: wfRecord.difficulty,
          taskProfile: wfRecord.taskProfile,
          actorRole: transition.role === null ? "base" : transition.role,
          initialState: childInitialState,
          capabilityArtifactHash: wfRecord.capabilityArtifactHash,
        });

        // ── Derive role, output schema, child workflow input ──────

        const role = transition.role;
        const outputSchema = getOutputSchema(transition.outputSchemaId);

        // Import transitionAuthorityForChild BEFORE using it.
        const { transitionAuthorityForChild } = await import(
          "../phenix-workflow/workflow-runtime.ts"
        );

        const childWorkflow: ResolvedWorkflowChildInput = {
          instanceId,
          actorId: childActorId,
          parentActorId: wfRecord.actorId,
          definitionId: wfRecord.definitionId,
          definitionVersion: 1,
          difficulty: wfRecord.difficulty,
          initialState: childInitialState,
          transitionAuthority: transitionAuthorityForChild({
            definition: dependencies.definition,
            role: transition.role,
            initialState: childInitialState,
            authorizedRoles: dependencies.authority.roles.effective,
          }),
          capabilityArtifactHash: wfRecord.capabilityArtifactHash,
        };

        // ── Derive variables needed by the remaining code ────────

        const capabilityArtifact = dependencies.capabilities;
        const difficulty = wfRecord.difficulty;
        const actorId = wfRecord.actorId;
        const sourceState = sourceStateBefore;
        const sourceRevision = sourceRevisionBefore;

        const creator: ContractCreatorContext =
          runtimeCtx?.kind === "child"
            ? { kind: "child", contract: runtimeCtx.contract }
            : { kind: "root", maximumDelegationDepth: 4 };

        // ── Resolve producer child spec ──────────────────────────────

        const producerSpec = resolveChildSpec({
          role,
          task: params.task,
          requirements,
          outputSchema,
          tools: params.tools ?? null,
          delegateRoles: params.delegateRoles as
            { additional?: readonly AgentRole[]; removed?: readonly AgentRole[] } | null | undefined,
          cwd: ctx.cwd,
          creator,
          capabilityArtifact,
          workflow: childWorkflow,
        });

        // ── Resolve critic spec if required ───────────────────────────

        let criticSpec: ResolvedChildSpec | undefined;
        if (producerSpec.criticRequired) {
          const criticTask = `Review the completed handoff: ${params.task.slice(0, 200)}`;
          const criticOutputSchema = getOutputSchema("critic-handoff");

          const criticActorId = `critic_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const criticWorkflow: ResolvedWorkflowChildInput = {
            instanceId,
            actorId: criticActorId,
            parentActorId: childActorId,
            definitionId: wfRecord.definitionId,
            definitionVersion: 1,
            difficulty,
            initialState: "reviewing",
            transitionAuthority: { kind: "restricted", allowed: [] },
            capabilityArtifactHash: wfRecord.capabilityArtifactHash,
          };

          criticSpec = resolveChildSpec({
            role: "critic",
            task: criticTask,
            requirements,
            outputSchema: criticOutputSchema,
            tools: null,
            delegateRoles: null,
            cwd: ctx.cwd,
            creator: { kind: "runtime-internal", maximumDelegationDepth: 0 },
            capabilityArtifact,
            workflow: criticWorkflow,
          });
        }

        // ── Build workflow binding ────────────────────────────────────

        const workflowBinding: WorkflowBinding = {
          instanceId,
          actorId,
          transitionExecutionId: executionId,
          transitionId: transition.id,
          sourceState,
          sourceRevision,
          acceptedState: transition.onAccepted,
          rejectedState: transition.onRejected,
        };

        // ── Create handle record ──────────────────────────────────────

        const record = createHandle(
          ctx,
          producerSpec,
          criticSpec,
          params.task,
          requirements,
          outputSchema,
          /* parentId */ undefined,
          workflowBinding,
        );

        // ── Write handle and update active transition handleId ────────

        writeRecord(ctx.cwd, record);

        // ── Run or background ─────────────────────────────────────────

        if (isBackground) {
          runAttempt(backend, ctx, signal, record)
            .then((runnerResult) => {
              finalizeHandleWorkflow(
                ctx.cwd,
                instanceId,
                actorId,
                executionId,
                runnerResult.record.status as "completed" | "failed" | "cancelled",
                transition.onAccepted,
                transition.onRejected,
              );
            })
            .catch(() => {
              // Errors captured in record.
            });

          return toolResult(record);
        }

        // Foreground: await completion.
        const runnerResult = await runAttempt(
          backend,
          ctx,
          signal,
          record,
        );

        const finalRecord = runnerResult.record;

        // ── Update workflow state ─────────────────────────────────────

        finalizeHandleWorkflow(
          ctx.cwd,
          instanceId,
          actorId,
          executionId,
          finalRecord.status as "completed" | "failed" | "cancelled",
          transition.onAccepted,
          transition.onRejected,
        );

        return toolResult(finalRecord);
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  // ── phenix_agent tool ─────────────────────────────────────────────────

  pi.registerTool({
    name: "phenix_agent",
    label: "Phenix Agent",
    description:
      "Inspect, await, poll, cancel, or display the persistent tree of Phenix subagent handles.",
    parameters: AgentParams,

    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal,
      _onUpdate:
        | ((result: AgentToolResult<Details>) => void)
        | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const params = rawParams as {
        action: "await" | "poll" | "cancel" | "inspect" | "tree";
        id?: string;
      };

      if (params.action === "tree") {
        const payload = treePayload(
          listRecords(ctx.cwd, effectiveSessionId(ctx)),
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
          details: payload,
        };
      }

      if (!params.id) {
        return errorResult(
          `phenix_agent action '${params.action}' requires id`,
        );
      }

      const record = readRecord(
        ctx.cwd,
        effectiveSessionId(ctx),
        params.id,
      );

      if (!record) {
        return errorResult(
          `Phenix handle not found: ${params.id}`,
        );
      }

      if (params.action === "inspect") return toolResult(record);

      if (params.action === "cancel") {
        if (!TERMINAL_STATES.has(record.status)) {
          const attempt = latestAttempt(record);
          try {
            await backend.interrupt(attempt.runId, signal);
          } catch {
            await backend.stop(attempt.runId, signal).catch(() => undefined);
          }
          attempt.status = "cancelled";
          attempt.endedAt = now();
          record.status = "cancelled";
          record.errors = ["cancelled by parent"];
          writeRecord(ctx.cwd, record);
        }
        return toolResult(record);
      }

      // await / poll
      if (
        record.status === "running" &&
        latestAttempt(record).mode === "background"
      ) {
        const resolved = await resolveBackground(
          backend,
          ctx,
          signal,
          record,
          params.action === "await",
        );
        return toolResult(resolved);
      }

      return toolResult(record);
    },
  });
}
