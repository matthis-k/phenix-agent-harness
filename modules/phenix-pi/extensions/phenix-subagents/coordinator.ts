/**
 * coordinator — Phenix agent execution coordinator
 *
 * Orchestrates child session delegation using the new Pi-native child-session
 * runtime. Workflow transitions, routing, contract validation, verification,
 * critic decisions, repair limits, budgets, and acceptance remain
 * deterministic in TypeScript.
 *
 * The coordinator uses:
 * - ChildSessionBackend to start live child runs
 * - ContractSubmissionChannel for closure-bound completion tool isolation
 * - ChildSessionRegistry for background mode (live-run registry, no polling)
 * - executeProducerCycles for repair cycles over one Pi session
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

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

import type {
  ChildSessionBackend,
  ChildRun,
  ChildSessionSpec,
} from "../phenix-runtime/child-session-types.ts";
import { childRunId } from "../phenix-runtime/child-session-types.ts";
import type { ParentExecutionContext } from "../phenix-runtime/delegation-tool.ts";
import {
  ContractSubmissionChannelImpl,
} from "../phenix-runtime/contract-channel.ts";
import {
  getChildSessionRegistry,
} from "../phenix-runtime/child-session-registry.ts";
import type { LiveChildRunRecord, AttemptRunResult } from "../phenix-runtime/child-session-registry.ts";

import type { WorkflowBinding, HandleRecord } from "./handle-types.ts";
import { HANDLE_VERSION } from "./handle-types.ts";
import {
  effectiveSessionId,
  listRecords,
  now,
  writeRecord,
  readRecord,
} from "./handle-store.ts";
import {
  createAttemptContract,
} from "./handle-evaluation.ts";
import type {
  ContractCreatorContext,
  ResolvedChildSpec,
  ResolvedWorkflowChildInput,
} from "./child-spec.ts";
import { resolveChildSpec } from "./child-spec.ts";
import { resolveChildRoute } from "../phenix-routing/child-route.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// ── Delegate execution parameters ───────────────────────────────────────────

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

// ── Handle creation ─────────────────────────────────────────────────────────

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
    status: "starting",
    producerCycles: [],
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

// ── Coordinator ─────────────────────────────────────────────────────────────

export interface AgentExecutionCoordinatorOptions {
  readonly backend: ChildSessionBackend;
  readonly resolveModelRegistry: () => ModelRegistry;
  readonly agentDir: string;
  readonly maximumDelegationDepth: number;
}

export class AgentExecutionCoordinator {
  private readonly backend: ChildSessionBackend;
  private readonly resolveModelRegistry: () => ModelRegistry;
  private readonly maximumDelegationDepth: number;

  constructor(options: AgentExecutionCoordinatorOptions) {
    this.backend = options.backend;
    this.resolveModelRegistry = options.resolveModelRegistry;
    this.maximumDelegationDepth = options.maximumDelegationDepth;
  }

  async delegate(input: {
    readonly params: DelegateExecutionParams;
    readonly ctx: ExtensionContext;
    readonly signal: AbortSignal;
    readonly parent?: ParentExecutionContext;
  }): Promise<DelegateExecutionResult> {
    return this.delegateInternal(input);
  }

  /**
   * Internal delegation used by both root and child delegation tools.
   */
  private async delegateInternal(input: {
    readonly params: DelegateExecutionParams;
    readonly ctx: ExtensionContext;
    readonly signal: AbortSignal;
    readonly parent?: ParentExecutionContext;
  }): Promise<DelegateExecutionResult> {
    const { params, ctx, signal } = input;

    // ── Validate parameters ──────────────────────────────────────────
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

    // ── Build workflow runtime dependencies ───────────────────────────
    const sessionId = effectiveSessionId(ctx);
    const parent = input.parent ?? {
      kind: "root" as const,
      sessionId,
      cwd: ctx.cwd,
      maximumDelegationDepth: this.maximumDelegationDepth,
    };

    const source = parent.kind === "child"
      ? { kind: "child" as const, contract: parent.contractId as any }
      : { kind: "root" as const, sessionId };

    const dependencies = buildWorkflowRuntimeDependencies({
      cwd: ctx.cwd,
      sessionId,
      source: source as any,
      handleStore: { listRecords },
    });

    let wfRecord = dependencies.record;
    const decision = buildWorkflowDecisionContext({
      definition: dependencies.definition,
      runtime: dependencies.record,
      authority: dependencies.authority,
      activeHandles: dependencies.activeHandles,
    });

    // ── Validate authority digest ─────────────────────────────────────
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

    // ── Validate transition ──────────────────────────────────────────
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

    // ── Begin workflow transition ─────────────────────────────────────
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

    // ── Create child workflow record ──────────────────────────────────
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
    const creator: ContractCreatorContext = parent.kind === "child"
      ? { kind: "child", contract: parent.contractId as any }
      : { kind: "root", maximumDelegationDepth: this.maximumDelegationDepth };

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

    // ── Resolve critic spec if required ───────────────────────────────
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

    // ── Resolve concrete model via routing ────────────────────────────
    let concreteModel: { readonly provider: string; readonly id: string };
    try {
      const route = await resolveChildRoute({
        modelSet: "mixed" as any,
        role,
        difficulty: wfRecord.difficulty,
      });
      concreteModel = {
        provider: route.model.provider,
        id: route.model.model,
      };

      // Verify the model exists in the registry before starting.
      const model = this.resolveModelRegistry().find(concreteModel.provider, concreteModel.id);
      if (!model) {
        record.status = "failed";
        record.errors = [`MODEL_NOT_FOUND: ${concreteModel.provider}/${concreteModel.id}`];
        writeRecord(ctx.cwd, record);
        return {
          ok: false,
          message: `phenix_delegate: configured child model ${concreteModel.provider}/${concreteModel.id} is unavailable.`,
          details: { code: "MODEL_NOT_FOUND" },
        };
      }
    } catch (error) {
      record.status = "failed";
      record.errors = [error instanceof Error ? error.message : String(error)];
      writeRecord(ctx.cwd, record);
      return {
        ok: false,
        message: `phenix_delegate: routing failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // ── Issue contract and create channel ─────────────────────────────
    const issuedContract = await createAttemptContract({
      spec: producerSpec,
      assignment: {
        task: params.task,
        requirements,
        outputSchema,
      },
      identity: {
        handleId: record.id,
        parentHandleId: record.parentId,
      },
      cwd: ctx.cwd,
    });

    const contractArtifact = issuedContract.artifact;

    // Build contract store for the channel
    const { FileContractStore } = await import("./contract-store.ts");
    const { findProjectRoot } = await import("./handle-store.ts");
    const store = new FileContractStore(
      path.join(findProjectRoot(ctx.cwd), ".phenix-agent-state", "contracts"),
    );
    const contractChannel = new ContractSubmissionChannelImpl(store, contractArtifact);

    // ── Prepare child session spec ────────────────────────────────────
    const childRunIdVal = childRunId(`child_${record.id}`);
    const spec: ChildSessionSpec = {
      id: childRunIdVal,
      ...(record.parentId ? { parentId: childRunId(record.parentId) } : {}),
      rootId: childRunIdVal,
      handleId: record.id,
      agentClient: {
        id: producerSpec.agent.replace("phenix.", "") as any,
        kind: "agent" as any,
      },
      role: producerSpec.role,
      cwd: ctx.cwd,
      model: concreteModel,
      thinkingLevel: producerSpec.thinking,
      initialPrompt: params.task,
      contract: contractArtifact,
      effectiveTools: producerSpec.tools.effective,
      skillRefs: producerSpec.skills,
      extensionRefs: producerSpec.extensions,
      inheritProjectContext: true,
      timeoutMs: producerSpec.timeoutMs,
      turnBudget: producerSpec.turnBudget,
      toolBudget: producerSpec.toolBudget,
      persistence: "file",
    };

    // ── Start the child run ───────────────────────────────────────────
    let run: ChildRun;
    try {
      run = await this.backend.start(spec, signal);
    } catch (error) {
      record.status = "failed";
      record.errors = [error instanceof Error ? error.message : String(error)];
      writeRecord(ctx.cwd, record);
      return {
        ok: false,
        message: `phenix_delegate: child session start failed: ${error instanceof Error ? error.message : String(error)}`,
        details: { code: "SESSION_START_FAILED" },
      };
    }

    // Record Pi session reference
    record.childRunId = run.id;
    record.backend = run.backend;
    record.piSessionId = run.pi.sessionId;
    record.piSessionFile = run.pi.sessionFile;
    record.status = "running";
    writeRecord(ctx.cwd, record);

    // ── Execute producer cycles ───────────────────────────────────────
    const { executeProducerCycles } = await import("./attempt-runner.ts");

    const executeCycles = async (): Promise<AttemptRunResult> => {
      return executeProducerCycles({
        run,
        contractChannel,
        contractArtifact,
        record,
        cwd: ctx.cwd,
        signal,
        maximumProducerCycles: producerSpec.maxRepairAttempts + 1,
        completionGraceRemaining: 1,
        backend: this.backend,
      });
    };

    if (isBackground) {
      // Register the live completion promise in the registry.
      const controller = new AbortController();
      const completionPromise = executeCycles();

      const liveRecord: LiveChildRunRecord = {
        run,
        completion: completionPromise,
        controller,
      };

      getChildSessionRegistry().add(liveRecord);

      // Finalize workflow after completion (async, best-effort).
      completionPromise
        .then((result) => {
          finalizeHandleWorkflow({ cwd: ctx.cwd, handle: result.record as any });
          getChildSessionRegistry().remove(run.id);
        })
        .catch(() => {
          getChildSessionRegistry().remove(run.id);
        });

      return { ok: true, record };
    }

    // Foreground — await completion
    const result = await executeCycles();
    const finalRecord = result.record as HandleRecord;
    finalizeHandleWorkflow({ cwd: ctx.cwd, handle: finalRecord as any });
    return { ok: true, record: finalRecord };
  }

  // ── Background operations: poll, await, cancel ────────────────────────

  async poll(ctx: ExtensionContext, id: string): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record) return undefined;

    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "orphaned") {
      return record;
    }

    if (!record.childRunId) return record;

    const registry = getChildSessionRegistry();
    const live = registry.get(record.childRunId);
    if (!live) {
      // No live entry — do not rerun. Mark orphaned if nonterminal.
      if (record.status === "running" || record.status === "starting") {
        record.status = "orphaned";
        writeRecord(ctx.cwd, record);
      }
      return record;
    }

    // Inspect the existing live promise/snapshot — do not create a new attempt.
    return record;
  }

  async awaitHandle(ctx: ExtensionContext, id: string, _signal: AbortSignal): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record) return undefined;

    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "orphaned") {
      return record;
    }

    if (!record.childRunId) return record;

    const registry = getChildSessionRegistry();
    const live = registry.get(record.childRunId);
    if (!live) {
      if (record.status === "running" || record.status === "starting") {
        record.status = "orphaned";
        writeRecord(ctx.cwd, record);
      }
      return record;
    }

    // Await the same registered promise.
    const result = await live.completion;
    return result.record as HandleRecord | undefined;
  }

  async cancelHandle(ctx: ExtensionContext, id: string, reason: string): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record) return undefined;

    if (record.status === "completed" || record.status === "failed" || record.status === "cancelled" || record.status === "orphaned") {
      return record;
    }

    if (record.childRunId) {
      const registry = getChildSessionRegistry();
      const live = registry.get(record.childRunId);
      if (live) {
        // Abort the registered run — idempotent.
        try {
          live.controller.abort();
        } catch {
          // Already aborted — ignore.
        }
        try {
          await live.run.abort(reason);
        } catch {
          // Best-effort.
        }
        try {
          await live.run.dispose();
        } catch {
          // Best-effort.
        }
        registry.remove(record.childRunId);
      }
    }

    record.status = "cancelled";
    record.errors = [reason];
    writeRecord(ctx.cwd, record);
    return record;
  }
}
