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
import type {
  DelegationAuthority,
  WorkflowTransitionId,
} from "../phenix-workflow/workflow-types.ts";
import { computeOptionsDigest } from "../phenix-workflow/workflow-projection.ts";
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
  rejectTransition,
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
import {
  childRunId,
  ChildRuntimeError,
} from "../phenix-runtime/child-session-types.ts";
import type { ParentExecutionContext } from "../phenix-runtime/delegation-tool.ts";
import {
  ContractSubmissionChannelImpl,
} from "../phenix-runtime/contract-channel.ts";
import {
  getChildSessionRegistry,
} from "../phenix-runtime/child-session-registry.ts";
import type { LiveChildRunRecord, AttemptRunResult } from "../phenix-runtime/child-session-registry.ts";

import type {
  CriticValue,
  WorkflowBinding,
  HandleRecord,
} from "./handle-types.ts";
import {
  CRITIC_OUTPUT_SCHEMA,
  HANDLE_VERSION,
} from "./handle-types.ts";
import {
  effectiveSessionId,
  findProjectRoot,
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
import {
  modelSetForModelId,
  PHENIX_PROVIDER,
} from "../phenix-routing/provider.ts";
import { FileContractStore } from "./contract-store.ts";
import { validateContract } from "./contracts.ts";
import { runVerificationCommands } from "./verification.ts";
import type {
  CriticRunInput,
  CriticRunResult,
  VerificationInput,
  VerificationResult,
} from "./attempt-runner.ts";
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
  readonly id: string;
  readonly sessionId: string;
  readonly ctx: ExtensionContext;
  readonly producerSpec: ResolvedChildSpec;
  readonly criticSpec?: ResolvedChildSpec;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly outputSchema: Record<string, unknown>;
  readonly modelSet: string;
  readonly parentId?: string;
  readonly workflowBinding?: WorkflowBinding;
}): HandleRecord {
  return {
    version: HANDLE_VERSION,
    id: input.id,
    sessionId: input.sessionId,
    parentId: input.parentId,
    modelSet: input.modelSet,
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
  readonly activeModelSet: string;
  readonly agentDir: string;
  readonly maximumDelegationDepth: number;
}

export class AgentExecutionCoordinator {
  private readonly backend: ChildSessionBackend;
  private readonly resolveModelRegistry: () => ModelRegistry;
  private readonly activeModelSet: string;
  private readonly maximumDelegationDepth: number;

  constructor(options: AgentExecutionCoordinatorOptions) {
    this.backend = options.backend;
    this.resolveModelRegistry = options.resolveModelRegistry;
    this.activeModelSet = options.activeModelSet;
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
    const invocationSessionId = effectiveSessionId(ctx);
    const parent = input.parent ?? {
      kind: "root" as const,
      sessionId: invocationSessionId,
      cwd: ctx.cwd,
      maximumDelegationDepth: this.maximumDelegationDepth,
    };
    // Nested handles stay in the root Phenix session namespace even though
    // the model-facing ExtensionContext belongs to the child Pi session.
    const sessionId =
      parent.kind === "child" ? parent.sessionId : invocationSessionId;
    const selectedModelSet =
      parent.kind === "child" && parent.modelSet
        ? parent.modelSet
        : ctx.model.provider === PHENIX_PROVIDER
          ? modelSetForModelId(ctx.model.id) ?? this.activeModelSet
          : this.activeModelSet;

    const source = parent.kind === "child"
      ? { kind: "child" as const, contract: parent.contract }
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

    const rejectStartedTransition = (): void => {
      try {
        rejectTransition(ctx.cwd, wfRecord, {
          executionId,
          nextState: transition.onRejected,
        });
      } catch {
        // Best effort. rejectTransition is idempotent for completed executions.
      }
    };

    try {
    // ── Create child workflow record ──────────────────────────────────
    const role = roleForAgentClient(transition.agentClient);
    const childInitialState = initialStateForRole(role) as ResolvedWorkflowChildInput["initialState"];

    const childRuntimeRecord = createWorkflowRecord(ctx.cwd, {
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
      ? { kind: "child", contract: parent.contract }
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
      id: handleId,
      sessionId,
      ctx,
      producerSpec,
      criticSpec,
      task: params.task,
      requirements,
      outputSchema,
      modelSet: selectedModelSet,
      ...(parent.kind === "child" && parent.handleId
        ? { parentId: parent.handleId }
        : {}),
      workflowBinding,
    });

    writeRecord(ctx.cwd, record);

    // ── Resolve concrete model via routing ────────────────────────────
    let concreteModel: { readonly provider: string; readonly id: string };
    try {
      const route = await resolveChildRoute({
        modelSet: selectedModelSet as any,
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
        finalizeHandleWorkflow({ cwd: ctx.cwd, handle: record as any });
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
      finalizeHandleWorkflow({ cwd: ctx.cwd, handle: record as any });
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

    const store = new FileContractStore(
      path.join(findProjectRoot(ctx.cwd), ".phenix-agent-state", "contracts"),
    );
    const contractChannel = new ContractSubmissionChannelImpl(
      store,
      contractArtifact,
    );

    const childAuthority: DelegationAuthority = {
      roles: contractArtifact.runtime.delegation.roles,
      availableRoles: contractArtifact.runtime.delegation.availableRoles,
      remainingDepth: contractArtifact.runtime.delegation.remainingDepth,
      transitionAuthority:
        contractArtifact.runtime.workflow.transitionAuthority,
    };
    const workflowProjection = buildWorkflowDecisionContext({
      definition: dependencies.definition,
      runtime: childRuntimeRecord,
      authority: childAuthority,
      activeHandles: [],
    });

    // ── Prepare child session spec ────────────────────────────────────
    const childRunIdVal = childRunId(`child_${record.id}`);
    const parentRunId =
      parent.kind === "child" && parent.childRunId
        ? childRunId(parent.childRunId)
        : undefined;
    const rootRunId =
      parent.kind === "child" && parent.rootChildRunId
        ? childRunId(parent.rootChildRunId)
        : childRunIdVal;
    const spec: ChildSessionSpec = {
      id: childRunIdVal,
      ...(parentRunId ? { parentId: parentRunId } : {}),
      rootId: rootRunId,
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
      workflowProjection,
      contractChannel,
      parentContext: {
        kind: "child",
        sessionId,
        cwd: ctx.cwd,
        contractId: contractArtifact.id,
        contract: contractArtifact,
        handleId: record.id,
        childRunId: childRunIdVal,
        rootChildRunId: rootRunId,
        modelSet: selectedModelSet,
        maximumDelegationDepth:
          contractArtifact.runtime.delegation.remainingDepth,
      },
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
    // One coordinator-owned scope covers model execution, deterministic
    // verification, and critic execution. Background work is detached from
    // the launching tool call but still receives the same total deadline.
    const runController = new AbortController();
    const abortFromParent = (): void => {
      if (!runController.signal.aborted) {
        runController.abort(
          signal.reason ??
            new ChildRuntimeError(
              "ABORTED",
              "Delegated execution was cancelled by its parent.",
            ),
        );
      }
    };

    if (!isBackground) {
      if (signal.aborted) {
        abortFromParent();
      } else {
        signal.addEventListener("abort", abortFromParent, { once: true });
      }
    }

    let executionTimeout: NodeJS.Timeout | undefined;
    if (producerSpec.timeoutMs > 0) {
      executionTimeout = setTimeout(() => {
        if (!runController.signal.aborted) {
          runController.abort(
            new ChildRuntimeError(
              "TIMEOUT",
              `Delegated execution timed out after ${producerSpec.timeoutMs}ms.`,
            ),
          );
        }
      }, producerSpec.timeoutMs);
      executionTimeout.unref?.();
    }

    const cleanupRunScope = (): void => {
      if (!isBackground) {
        signal.removeEventListener("abort", abortFromParent);
      }
      if (executionTimeout) {
        clearTimeout(executionTimeout);
        executionTimeout = undefined;
      }
    };

    const runSignal = runController.signal;

    let run: ChildRun;
    try {
      run = await this.backend.start(spec, runSignal);
    } catch (error) {
      cleanupRunScope();
      record.status = "failed";
      record.errors = [error instanceof Error ? error.message : String(error)];
      writeRecord(ctx.cwd, record);
      finalizeHandleWorkflow({ cwd: ctx.cwd, handle: record as any });
      return {
        ok: false,
        message: `phenix_delegate: child session start failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          code:
            error instanceof ChildRuntimeError
              ? error.code
              : "SESSION_START_FAILED",
        },
      };
    }

    // Record Pi session reference
    record.childRunId = run.id;
    record.rootChildRunId = run.snapshot().rootId;
    record.backend = run.backend;
    record.piSessionId = run.pi.sessionId;
    record.piSessionFile = run.pi.sessionFile;
    record.status = "running";
    writeRecord(ctx.cwd, record);

    // ── Execute producer cycles ───────────────────────────────────────
    const { executeProducerCycles } = await import("./attempt-runner.ts");

    const executeCycles = async (): Promise<AttemptRunResult> => {
      try {
        return await executeProducerCycles({
          run,
          contractChannel,
          contractArtifact,
          record,
          cwd: ctx.cwd,
          signal: runSignal,
          maximumProducerCycles: producerSpec.maxRepairAttempts + 1,
          completionGraceRemaining: 1,
          verify: (verificationInput) =>
            this.verifyProducer(verificationInput),
          criticFactory: (backend, criticInput) =>
            this.runCritic(backend, criticInput),
          backend: this.backend,
        });
      } finally {
        cleanupRunScope();
        await run.dispose();
      }
    };

    if (isBackground) {
      // Register the live completion promise in the registry.
      const completionPromise = executeCycles();

      const liveRecord: LiveChildRunRecord = {
        run,
        completion: completionPromise,
        controller: runController,
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
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.error?.message ??
          "Delegated child execution failed.",
        details: {
          code: result.error?.code ?? "CHILD_EXECUTION_FAILED",
          handleId: finalRecord.id,
          status: finalRecord.status,
        },
      };
    }
    return { ok: true, record: finalRecord };
    } catch (error) {
      rejectStartedTransition();
      throw error;
    }
  }

  private async verifyProducer(
    input: VerificationInput,
  ): Promise<VerificationResult> {
    const runs = await runVerificationCommands(
      input.record.producerSpec.verificationCommands,
      input.cwd,
      input.signal,
    );

    const failed = runs.filter(
      (run) =>
        run.status === "failed" ||
        run.status === "timed-out" ||
        run.status === "cancelled",
    );
    const summary = {
      acceptanceStatus: failed.length === 0 ? "verified" : "rejected",
      runtimeChecks: [],
      verifyRuns: runs.map(
        (run) =>
          `${run.id}: ${run.status}` +
          (run.exitCode === null ? "" : ` (exit ${run.exitCode})`),
      ),
      reviewFindings: [],
      contract: "valid" as const,
    };

    return {
      ok: failed.length === 0,
      issues: failed.map((run) => ({
        path: ["verification", run.id],
        code: run.status,
        message: [
          `Verification command "${run.id}" ${run.status}.`,
          run.stderr,
          run.stdout,
        ]
          .filter(Boolean)
          .join("\n"),
      })),
      summary,
    };
  }

  private async runCritic(
    backend: ChildSessionBackend,
    input: CriticRunInput,
  ): Promise<CriticRunResult> {
    const criticSpec = input.record.criticSpec;
    if (!criticSpec) {
      throw new Error("Required critic specification is missing.");
    }

    const criticTask = [
      `Review the completed Phenix child assignment for handle "${input.record.id}".`,
      "",
      `Original task: ${input.record.assignment.task}`,
      "",
      "Requirements:",
      ...input.record.assignment.requirements.map(
        (requirement, index) => `${index + 1}. ${requirement}`,
      ),
      "",
      "Producer result:",
      JSON.stringify(input.producerValue, null, 2),
      "",
      "Deterministic verification evidence:",
      JSON.stringify(input.verification, null, 2),
      "",
      "Return an independent approve/reject verdict through phenix_complete.",
    ].join("\n");

    const issued = await createAttemptContract({
      spec: criticSpec,
      assignment: {
        task: criticTask,
        requirements: input.record.assignment.requirements,
        outputSchema: CRITIC_OUTPUT_SCHEMA,
      },
      identity: {
        handleId: `${input.record.id}-critic-${randomUUID()}`,
        parentHandleId: input.record.id,
      },
      cwd: input.cwd,
    });

    const store = new FileContractStore(
      path.join(
        findProjectRoot(input.cwd),
        ".phenix-agent-state",
        "contracts",
      ),
    );
    const channel = new ContractSubmissionChannelImpl(
      store,
      issued.artifact,
    );

    const route = await resolveChildRoute({
      modelSet: input.record.modelSet as any,
      role: "critic",
      difficulty: criticSpec.workflow.difficulty,
    });
    const model = {
      provider: route.model.provider,
      id: route.model.model,
    };
    if (!this.resolveModelRegistry().find(model.provider, model.id)) {
      throw new Error(
        `Configured critic model ${model.provider}/${model.id} is unavailable.`,
      );
    }

    const runId = childRunId(
      `critic_${input.record.id}_${randomUUID()}`,
    );
    const rootRunId =
      input.record.rootChildRunId ?? input.record.childRunId ?? runId;
    const workflowProjection = {
      difficulty: criticSpec.workflow.difficulty,
      currentState: "reviewing",
      revision: 0,
      optionsDigest: computeOptionsDigest([]),
      options: [],
    } as const;

    const spec: ChildSessionSpec = {
      id: runId,
      ...(input.record.childRunId
        ? { parentId: input.record.childRunId }
        : {}),
      rootId: rootRunId,
      handleId: `${input.record.id}-critic`,
      agentClient: {
        id: criticSpec.agent.replace("phenix.", "") as any,
        kind: "agent" as any,
      },
      role: "critic",
      cwd: input.cwd,
      model,
      thinkingLevel: criticSpec.thinking,
      initialPrompt: criticTask,
      contract: issued.artifact,
      workflowProjection,
      contractChannel: channel,
      parentContext: {
        kind: "child",
        sessionId: input.record.sessionId,
        cwd: input.cwd,
        contractId: issued.artifact.id,
        contract: issued.artifact,
        handleId: `${input.record.id}-critic`,
        childRunId: runId,
        rootChildRunId: rootRunId,
        modelSet: input.record.modelSet,
        maximumDelegationDepth: 0,
      },
      effectiveTools: criticSpec.tools.effective,
      skillRefs: criticSpec.skills,
      extensionRefs: criticSpec.extensions,
      inheritProjectContext: true,
      timeoutMs: criticSpec.timeoutMs,
      turnBudget: criticSpec.turnBudget,
      toolBudget: criticSpec.toolBudget,
      persistence: "file",
    };

    const run = await backend.start(spec, input.signal);
    try {
      const outcome = await run.waitForCurrentCycle(input.signal);
      if (outcome.status !== "settled") {
        throw new Error(
          outcome.error?.message ??
            "Critic session did not settle successfully.",
        );
      }

      const submitted = await channel.readSubmitted();
      if (!submitted) {
        throw new Error("Critic did not submit a structured verdict.");
      }

      const validation = validateContract(
        CRITIC_OUTPUT_SCHEMA,
        submitted.value,
      );
      if (!validation.ok) {
        throw new Error(
          `Critic verdict failed schema validation: ${validation.summary}`,
        );
      }

      await channel.accept(submitted.value);
      return submitted.value as CriticValue;
    } finally {
      await run.dispose();
    }
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
