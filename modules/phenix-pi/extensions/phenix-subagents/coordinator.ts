import { randomUUID } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRole } from "../phenix-kernel/agents.ts";
import type { WorkflowTransitionId } from "../phenix-workflow/workflow-types.ts";
import {
  actorRoleForAgentClient,
  outputSchemaIdForContract,
  roleForAgentClient,
} from "../phenix-workflow/workflow-types.ts";
import {
  PHENIX_DEFAULT_WORKFLOW,
  buildWorkflowDecisionContext,
  buildWorkflowRuntimeDependencies,
  getOutputSchema,
} from "../phenix-workflow/index.ts";
import {
  beginTransition,
  createWorkflowRecord,
  WorkflowStoreError,
} from "../phenix-workflow/workflow-store.ts";
import {
  finalizeHandleWorkflow,
  transitionAuthorityForChild,
} from "../phenix-workflow/workflow-runtime.ts";

import type { AgentSessionPort } from "./session-port.ts";
import type {
  ContractCreatorContext,
  ResolvedChildSpec,
  ResolvedWorkflowChildInput,
} from "./child-spec.ts";
import { resolveChildSpec } from "./child-spec.ts";
import type { WorkflowBinding, HandleRecord } from "./handle-types.ts";
import { HANDLE_VERSION } from "./handle-types.ts";
import {
  effectiveSessionId,
  listRecords,
  now,
  writeRecord,
} from "./handle-store.ts";
import { runAttempt } from "./attempt-runner.ts";
import { getRuntimeContext } from "./contract-runtime-context.ts";

export interface DelegateExecutionParams {
  readonly transitionId: string;
  readonly workflowRevision: number;
  readonly authorityDigest?: string;
  readonly task: string;
  readonly requirements?: readonly string[];
  readonly tools?: {
    readonly additional?: readonly string[];
    readonly removed?: readonly string[];
  } | null;
  readonly delegateRoles?: {
    readonly additional?: readonly string[];
    readonly removed?: readonly string[];
  } | null;
  readonly mode?: "await" | "background";
}

export type DelegateExecutionResult =
  | { readonly ok: true; readonly record: HandleRecord }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

function createHandle(input: {
  readonly ctx: ExtensionContext;
  readonly producerSpec: ResolvedChildSpec;
  readonly criticSpec?: ResolvedChildSpec;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly outputSchema: Record<string, unknown>;
  readonly parentId?: string;
  readonly workflowBinding?: WorkflowBinding;
}): HandleRecord {
  return {
    version: HANDLE_VERSION,
    id: randomUUID(),
    sessionId: effectiveSessionId(input.ctx),
    parentId: input.parentId,
    assignment: {
      task: input.task,
      requirements: [...input.requirements],
      outputSchema: input.outputSchema,
    },
    producerSpec: input.producerSpec,
    ...(input.criticSpec ? { criticSpec: input.criticSpec } : {}),
    ...(input.workflowBinding ? { workflowBinding: input.workflowBinding } : {}),
    createdAt: now(),
    updatedAt: now(),
    status: "running",
    attempts: [],
  };
}

function initialStateForRole(role: AgentRole) {
  return role === null
    ? "classified"
    : role === "scout" ? "scouting"
    : role === "planner" ? "planning"
    : role === "architect" ? "designing"
    : role === "implementer" ? "implementing"
    : role === "tester" ? "testing"
    : role === "critic" ? "reviewing"
    : "finalizing";
}

export class AgentExecutionCoordinator {
  constructor(
    private readonly port: AgentSessionPort,
  ) {}

  async delegate(input: {
    readonly params: DelegateExecutionParams;
    readonly ctx: ExtensionContext;
    readonly signal: AbortSignal;
  }): Promise<DelegateExecutionResult> {
    const { params, ctx, signal } = input;

    if (typeof params.transitionId !== "string" || params.transitionId.length === 0) {
      return { ok: false, message: "phenix_delegate: transitionId is required. Select one from the projected delegation options." };
    }
    if (typeof params.workflowRevision !== "number") {
      return { ok: false, message: "phenix_delegate: workflowRevision is required. Copy the revision from the projected delegation options." };
    }
    if (typeof params.task !== "string" || params.task.length === 0) {
      return { ok: false, message: "phenix_delegate: task is required." };
    }

    const requirements = [...(params.requirements ?? [])];
    const isBackground = params.mode === "background";

    const sessionId = effectiveSessionId(ctx);
    const runtimeCtx = getRuntimeContext();
    const source = runtimeCtx?.kind === "child"
      ? { kind: "child" as const, contract: runtimeCtx.contract }
      : { kind: "root" as const, sessionId };

    const dependencies = buildWorkflowRuntimeDependencies({
      cwd: ctx.cwd,
      sessionId,
      source,
      handleStore: { listRecords },
    });

    let wfRecord = dependencies.record;
    const decision = buildWorkflowDecisionContext({
      definition: dependencies.definition,
      runtime: dependencies.record,
      authority: dependencies.authority,
      activeHandles: dependencies.activeHandles,
    });

    if (
      typeof params.authorityDigest === "string" &&
      params.authorityDigest !== decision.optionsDigest
    ) {
      return {
        ok: false,
        message: "phenix_delegate: stale workflow authority digest.",
        details: {
          code: "STALE_WORKFLOW_AUTHORITY",
          expected: decision.optionsDigest,
          received: params.authorityDigest,
          state: decision.currentState,
          revision: decision.revision,
        },
      };
    }

    if (params.workflowRevision !== wfRecord.revision) {
      return {
        ok: false,
        message:
          `phenix_delegate: stale workflow revision. Expected ${params.workflowRevision}, current ${wfRecord.revision}. ` +
          `Current state: ${wfRecord.state}. Refresh delegation options before attempting again.`,
        details: { currentState: wfRecord.state, currentRevision: wfRecord.revision },
      };
    }

    const transitionId = params.transitionId as WorkflowTransitionId;
    const matchingOption = decision.options.find((o) => o.transitionId === transitionId);
    if (!matchingOption) {
      const availableIds = decision.options.map((o) => o.transitionId).join(", ");
      return {
        ok: false,
        message:
          `phenix_delegate: transition "${params.transitionId}" is not currently available. ` +
          `State: ${wfRecord.state}, Difficulty: ${wfRecord.difficulty}. ` +
          `Available transitions: ${availableIds || "(none)"}`,
        details: {
          state: wfRecord.state,
          difficulty: wfRecord.difficulty,
          available: decision.options.map((o) => ({
            id: o.transitionId,
            role: o.role,
            category: o.category,
          })),
        },
      };
    }

    if (isBackground && !matchingOption.allowedModes.includes("background")) {
      return {
        ok: false,
        message:
          `phenix_delegate: background mode is not allowed for transition "${params.transitionId}". ` +
          `Allowed modes: ${matchingOption.allowedModes.join(", ")}.`,
      };
    }

    const transition = PHENIX_DEFAULT_WORKFLOW.transitions.find((t) => t.id === transitionId);
    if (!transition) {
      return { ok: false, message: `phenix_delegate: internal error - transition "${params.transitionId}" not found in workflow definition.` };
    }
    if (transition.kind !== "delegate") {
      return { ok: false, message: `phenix_delegate: internal error - "${params.transitionId}" is not a delegate transition.` };
    }

    const handleId = randomUUID();
    const childActorId = `actor_${handleId}`;
    const instanceId = wfRecord.instanceId;
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
        return {
          ok: false,
          message: `phenix_delegate: workflow error [${err.code}]: ${err.message}`,
          details: { code: err.code, ...err.context } as Record<string, unknown>,
        };
      }
      throw err;
    }

    const role = roleForAgentClient(transition.agentClient);
    const childInitialState = initialStateForRole(role) as ResolvedWorkflowChildInput["initialState"]; 

    createWorkflowRecord(ctx.cwd, {
      instanceId,
      actorId: childActorId,
      parentActorId: wfRecord.actorId,
      sessionId,
      definitionId: wfRecord.definitionId,
      difficulty: wfRecord.difficulty,
      taskProfile: wfRecord.taskProfile,
      actorRole: actorRoleForAgentClient(transition.agentClient),
      initialState: childInitialState,
      capabilityArtifactHash: wfRecord.capabilityArtifactHash,
    });

    const outputSchema = getOutputSchema(outputSchemaIdForContract(transition.outputContract));
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
        role,
        initialState: childInitialState,
        authorizedRoles: dependencies.authority.roles.effective,
      }),
      capabilityArtifactHash: wfRecord.capabilityArtifactHash,
    };

    const capabilityArtifact = dependencies.capabilities;
    const creator: ContractCreatorContext = runtimeCtx?.kind === "child"
      ? { kind: "child", contract: runtimeCtx.contract }
      : { kind: "root", maximumDelegationDepth: 4 };

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
        difficulty: wfRecord.difficulty,
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

    const workflowBinding: WorkflowBinding = {
      instanceId,
      actorId: wfRecord.actorId,
      transitionExecutionId: executionId,
      transitionId: transition.id,
      sourceState: sourceStateBefore,
      sourceRevision: sourceRevisionBefore,
      acceptedState: transition.onAccepted,
      rejectedState: transition.onRejected,
    };

    const record = createHandle({
      ctx,
      producerSpec,
      criticSpec,
      task: params.task,
      requirements,
      outputSchema,
      workflowBinding,
    });

    writeRecord(ctx.cwd, record);

    if (isBackground) {
      runAttempt(this.port, ctx, signal, record)
        .then((runnerResult) => {
          finalizeHandleWorkflow({ cwd: ctx.cwd, handle: runnerResult.record });
        })
        .catch(() => {
          // Errors are captured in the handle record by the attempt runner.
        });

      return { ok: true, record };
    }

    const runnerResult = await runAttempt(this.port, ctx, signal, record);
    const finalRecord = runnerResult.record;
    finalizeHandleWorkflow({ cwd: ctx.cwd, handle: finalRecord });
    return { ok: true, record: finalRecord };
  }
}
