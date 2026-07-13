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
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { validateSchema } from "../phenix-contracts/validator.ts";
import type { AgentRole } from "../phenix-kernel/agents.ts";
import { modelSetId } from "../phenix-kernel/ids.ts";
import { agentClientRef } from "../phenix-kernel/refs.ts";
import { resolveChildRoute } from "../phenix-routing/child-route.ts";
import { modelSetForModelId, PHENIX_PROVIDER } from "../phenix-routing/provider.ts";
import type {
  AttemptRunResult,
  LiveChildRunRecord,
} from "../phenix-runtime/child-session-registry.ts";
import { getChildSessionRegistry } from "../phenix-runtime/child-session-registry.ts";
import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionSpec,
} from "../phenix-runtime/child-session-types.ts";
import {
  ChildRuntimeError,
  childRunId,
  isChildRuntimeErrorCode,
} from "../phenix-runtime/child-session-types.ts";
import { ContractSubmissionChannelImpl } from "../phenix-runtime/contract-channel.ts";
import type {
  DelegateExecutionParams,
  ParentExecutionContext,
} from "../phenix-runtime/delegation-tool.ts";
import {
  buildWorkflowDecisionContext,
  buildWorkflowRuntimeDependencies,
  getOutputSchema,
  PHENIX_DEFAULT_WORKFLOW,
} from "../phenix-workflow/index.ts";
import { computeOptionsDigest } from "../phenix-workflow/workflow-projection.ts";
import type { WorkflowActorSource } from "../phenix-workflow/workflow-runtime.ts";
import {
  finalizeHandleWorkflow,
  initialWorkflowStateForRole,
  transitionAuthorityForChild,
} from "../phenix-workflow/workflow-runtime.ts";
import {
  beginTransition,
  createWorkflowRecord,
  rejectTransition,
  WorkflowStoreError,
} from "../phenix-workflow/workflow-store.ts";
import type {
  DelegationAuthority,
  WorkflowTransitionId,
} from "../phenix-workflow/workflow-types.ts";
import {
  actorRoleForAgentClient,
  outputSchemaIdForContract,
  roleForAgentClient,
} from "../phenix-workflow/workflow-types.ts";
import type {
  CriticRunInput,
  CriticRunResult,
  VerificationInput,
  VerificationResult,
} from "./attempt-runner.ts";
import type {
  ContractCreatorContext,
  ResolvedChildSpec,
  ResolvedWorkflowChildInput,
} from "./child-spec.ts";
import { resolveChildSpec } from "./child-spec.ts";
import { FileContractStore } from "./contract-store.ts";
import { createAttemptContract } from "./handle-evaluation.ts";
import {
  effectiveSessionId,
  findProjectRoot,
  listRecords,
  now,
  readRecord,
  writeRecord,
} from "./handle-store.ts";
import type { CriticValue, HandleRecord, WorkflowBinding } from "./handle-types.ts";
import { CRITIC_OUTPUT_SCHEMA, HANDLE_VERSION, isTerminalHandleStatus } from "./handle-types.ts";
import { runVerificationCommands } from "./verification.ts";

// ── Delegate execution result ───────────────────────────────────────────────

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
      return {
        ok: false,
        message:
          "phenix_delegate: transitionId is required. Select one from the projected delegation options.",
      };
    }
    if (typeof params.workflowRevision !== "number") {
      return {
        ok: false,
        message:
          "phenix_delegate: workflowRevision is required. Copy the revision from the projected delegation options.",
      };
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
    const sessionId = parent.kind === "child" ? parent.sessionId : invocationSessionId;
    const selectedModelSet =
      parent.kind === "child" && parent.modelSet
        ? parent.modelSet
        : ctx.model?.provider === PHENIX_PROVIDER
          ? (modelSetForModelId(ctx.model.id) ?? this.activeModelSet)
          : this.activeModelSet;

    const source: WorkflowActorSource =
      parent.kind === "child"
        ? { kind: "child", contract: parent.contract }
        : { kind: "root", sessionId };

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
      return {
        ok: false,
        message: `phenix_delegate: internal error - transition "${params.transitionId}" not found in workflow definition.`,
      };
    }
    if (transition.kind !== "delegate") {
      return {
        ok: false,
        message: `phenix_delegate: internal error - "${params.transitionId}" is not a delegate transition.`,
      };
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

    const rejectStartedTransition = (): boolean => {
      try {
        rejectTransition(ctx.cwd, wfRecord, {
          executionId,
          nextState: transition.onRejected,
        });
        return true;
      } catch {
        // The transition may already be settled or persistence may have failed.
        return false;
      }
    };

    const finalizeOrRejectHandle = (handle: HandleRecord): void => {
      let finalizationError: unknown = new Error(
        `Workflow finalization returned no record for handle ${handle.id}.`,
      );

      // Retrying is useful when transition settlement succeeded but automatic
      // workflow advancement failed afterward. finalizeHandleWorkflow is
      // idempotent for already-completed transition executions.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const finalized = finalizeHandleWorkflow({
            cwd: ctx.cwd,
            handle,
          });
          if (finalized) return;
        } catch (error) {
          finalizationError = error;
        }
      }

      if (rejectStartedTransition()) return;

      const message =
        finalizationError instanceof Error ? finalizationError.message : String(finalizationError);
      handle.errors = [...(handle.errors ?? []), `WORKFLOW_FINALIZATION_FAILED: ${message}`];
      writeRecord(ctx.cwd, handle);
    };

    let ownedRun: ChildRun | undefined;
    let cleanupOwnedRunScope: (() => void) | undefined;
    try {
      // ── Create child workflow record ──────────────────────────────────
      const role = roleForAgentClient(transition.agentClient);
      const childInitialState = initialWorkflowStateForRole(role);

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
      const creator: ContractCreatorContext =
        parent.kind === "child"
          ? { kind: "child", contract: parent.contract }
          : { kind: "root", maximumDelegationDepth: this.maximumDelegationDepth };

      const producerSpec = resolveChildSpec({
        role,
        task: params.task,
        requirements,
        outputSchema,
        tools: params.tools ?? null,
        delegateRoles: params.delegateRoles as
          | { additional?: readonly AgentRole[]; removed?: readonly AgentRole[] }
          | null
          | undefined,
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
        ...(parent.kind === "child" && parent.handleId ? { parentId: parent.handleId } : {}),
        workflowBinding,
      });

      writeRecord(ctx.cwd, record);

      // ── Resolve concrete model via routing ────────────────────────────
      let concreteModel: { readonly provider: string; readonly id: string };
      try {
        const route = await resolveChildRoute({
          modelSet: modelSetId(selectedModelSet),
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
          finalizeOrRejectHandle(record);
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
        finalizeOrRejectHandle(record);
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
      const contractChannel = new ContractSubmissionChannelImpl(store, contractArtifact);

      const childAuthority: DelegationAuthority = {
        roles: contractArtifact.runtime.delegation.roles,
        availableRoles: contractArtifact.runtime.delegation.availableRoles,
        remainingDepth: contractArtifact.runtime.delegation.remainingDepth,
        transitionAuthority: contractArtifact.runtime.workflow.transitionAuthority,
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
        parent.kind === "child" && parent.childRunId ? childRunId(parent.childRunId) : undefined;
      const rootRunId =
        parent.kind === "child" && parent.rootChildRunId
          ? childRunId(parent.rootChildRunId)
          : childRunIdVal;
      const spec: ChildSessionSpec = {
        id: childRunIdVal,
        ...(parentRunId ? { parentId: parentRunId } : {}),
        rootId: rootRunId,
        handleId: record.id,
        agentClient: agentClientRef(producerSpec.agent.replace(/^phenix\./, "")),
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
          maximumDelegationDepth: contractArtifact.runtime.delegation.remainingDepth,
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
              new ChildRuntimeError("ABORTED", "Delegated execution was cancelled by its parent."),
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
      cleanupOwnedRunScope = cleanupRunScope;

      const runSignal = runController.signal;

      let run: ChildRun;
      try {
        run = await this.backend.start(spec, runSignal);
      } catch (error) {
        cleanupRunScope();
        record.status = "failed";
        record.errors = [error instanceof Error ? error.message : String(error)];
        writeRecord(ctx.cwd, record);
        finalizeOrRejectHandle(record);
        return {
          ok: false,
          message: `phenix_delegate: child session start failed: ${error instanceof Error ? error.message : String(error)}`,
          details: {
            code: error instanceof ChildRuntimeError ? error.code : "SESSION_START_FAILED",
          },
        };
      }
      ownedRun = run;

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
            verify: (verificationInput) => this.verifyProducer(verificationInput),
            criticFactory: (backend, criticInput) => this.runCritic(backend, criticInput),
            backend: this.backend,
          });
        } finally {
          cleanupRunScope();
          try {
            await run.dispose();
          } finally {
            ownedRun = undefined;
            cleanupOwnedRunScope = undefined;
          }
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

        // Finalize the same persisted handle on either settlement path. Promise
        // rejection must not leave a running handle after the live registry
        // entry is removed.
        void completionPromise
          .then(
            (result) => {
              const persisted = readRecord(ctx.cwd, sessionId, handleId);
              const settledRecord =
                persisted && isTerminalHandleStatus(persisted.status)
                  ? persisted
                  : (result.record as HandleRecord);
              finalizeOrRejectHandle(settledRecord);
            },
            (error) => {
              const failedRecord = readRecord(ctx.cwd, sessionId, handleId) ?? record;
              if (!isTerminalHandleStatus(failedRecord.status)) {
                failedRecord.status = "failed";
                failedRecord.errors = [error instanceof Error ? error.message : String(error)];
                writeRecord(ctx.cwd, failedRecord);
              }
              finalizeOrRejectHandle(failedRecord);
            },
          )
          .finally(() => {
            getChildSessionRegistry().remove(run.id);
          })
          .catch(() => undefined);

        return { ok: true, record };
      }

      // Foreground — await completion
      const result = await executeCycles();
      const finalRecord = result.record as HandleRecord;
      finalizeOrRejectHandle(finalRecord);
      if (!result.ok) {
        return {
          ok: false,
          message: result.error?.message ?? "Delegated child execution failed.",
          details: {
            code: result.error?.code ?? "CHILD_EXECUTION_FAILED",
            handleId: finalRecord.id,
            status: finalRecord.status,
          },
        };
      }
      return { ok: true, record: finalRecord };
    } catch (error) {
      cleanupOwnedRunScope?.();

      if (ownedRun) {
        try {
          await ownedRun.abort("delegation execution failed");
        } catch {
          // Best-effort provider abort.
        }
        try {
          await ownedRun.dispose();
        } catch {
          // Best-effort disposal.
        }
      }

      const failedRecord = readRecord(ctx.cwd, sessionId, handleId);
      if (failedRecord) {
        if (failedRecord.status === "starting" || failedRecord.status === "running") {
          failedRecord.status = "failed";
          failedRecord.errors = [error instanceof Error ? error.message : String(error)];
          writeRecord(ctx.cwd, failedRecord);
        }
        finalizeOrRejectHandle(failedRecord);
      } else {
        rejectStartedTransition();
      }

      return {
        ok: false,
        message: `phenix_delegate: execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        details: {
          code: error instanceof ChildRuntimeError ? error.code : "SESSION_START_FAILED",
          ...(failedRecord ? { handleId: failedRecord.id } : {}),
        },
      };
    }
  }

  private async verifyProducer(input: VerificationInput): Promise<VerificationResult> {
    const runs = await runVerificationCommands(
      input.record.producerSpec.verificationCommands,
      input.cwd,
      input.signal,
    );

    const failed = runs.filter(
      (run) => run.status === "failed" || run.status === "timed-out" || run.status === "cancelled",
    );
    const summary = {
      acceptanceStatus: failed.length === 0 ? "verified" : "rejected",
      runtimeChecks: [],
      verifyRuns: runs.map(
        (run) =>
          `${run.id}: ${run.status}${run.exitCode === null ? "" : ` (exit ${run.exitCode})`}`,
      ),
      reviewFindings: [],
      contract: "valid" as const,
    };

    return {
      ok: failed.length === 0,
      issues: failed.map((run) => ({
        path: ["verification", run.id],
        code: run.status,
        message: [`Verification command "${run.id}" ${run.status}.`, run.stderr, run.stdout]
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
      path.join(findProjectRoot(input.cwd), ".phenix-agent-state", "contracts"),
    );
    const channel = new ContractSubmissionChannelImpl(store, issued.artifact);

    const route = await resolveChildRoute({
      modelSet: modelSetId(input.record.modelSet),
      role: "critic",
      difficulty: criticSpec.workflow.difficulty,
    });
    const model = {
      provider: route.model.provider,
      id: route.model.model,
    };
    if (!this.resolveModelRegistry().find(model.provider, model.id)) {
      throw new Error(`Configured critic model ${model.provider}/${model.id} is unavailable.`);
    }

    const runId = childRunId(`critic_${input.record.id}_${randomUUID()}`);
    const rootRunId = input.record.rootChildRunId ?? input.record.childRunId ?? runId;
    const workflowProjection = {
      difficulty: criticSpec.workflow.difficulty,
      currentState: "reviewing",
      revision: 0,
      optionsDigest: computeOptionsDigest([]),
      options: [],
    } as const;

    const spec: ChildSessionSpec = {
      id: runId,
      ...(input.record.childRunId ? { parentId: input.record.childRunId } : {}),
      rootId: rootRunId,
      handleId: `${input.record.id}-critic`,
      agentClient: agentClientRef(criticSpec.agent.replace(/^phenix\./, "")),
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

    const criticController = new AbortController();
    const abortCriticFromParent = (): void => {
      if (!criticController.signal.aborted) {
        criticController.abort(
          input.signal.reason ??
            new ChildRuntimeError("ABORTED", "Critic execution was cancelled by its parent."),
        );
      }
    };

    if (input.signal.aborted) {
      abortCriticFromParent();
    } else {
      input.signal.addEventListener("abort", abortCriticFromParent, { once: true });
    }

    let criticTimeout: NodeJS.Timeout | undefined;
    if (criticSpec.timeoutMs > 0) {
      criticTimeout = setTimeout(() => {
        if (!criticController.signal.aborted) {
          criticController.abort(
            new ChildRuntimeError("TIMEOUT", `Critic timed out after ${criticSpec.timeoutMs}ms.`),
          );
        }
      }, criticSpec.timeoutMs);
      criticTimeout.unref?.();
    }

    let run: ChildRun | undefined;
    try {
      run = await backend.start(spec, criticController.signal);
      const outcome = await run.waitForCurrentCycle(criticController.signal);
      if (outcome.status !== "settled") {
        const code =
          outcome.status === "cancelled"
            ? "ABORTED"
            : isChildRuntimeErrorCode(outcome.error?.code)
              ? outcome.error.code
              : "PROVIDER_FAILED";
        throw new ChildRuntimeError(
          code,
          outcome.error?.message ?? "Critic session did not settle successfully.",
        );
      }

      const submitted = await channel.readSubmitted();
      if (!submitted) {
        throw new Error("Critic did not submit a structured verdict.");
      }

      const validation = validateSchema(CRITIC_OUTPUT_SCHEMA, submitted.value);
      if (!validation.ok) {
        throw new Error(`Critic verdict failed schema validation: ${validation.summary}`);
      }

      if (criticController.signal.aborted) {
        const reason = criticController.signal.reason;
        throw reason instanceof ChildRuntimeError
          ? reason
          : new ChildRuntimeError(
              "ABORTED",
              reason instanceof Error ? reason.message : "Critic execution was cancelled.",
            );
      }

      await channel.accept(submitted.value);
      return submitted.value as CriticValue;
    } finally {
      input.signal.removeEventListener("abort", abortCriticFromParent);
      if (criticTimeout) {
        clearTimeout(criticTimeout);
      }
      if (run) {
        await run.dispose();
      }
    }
  }

  // ── Background handle lifecycle ───────────────────────────────────────

  private finalizePersistedHandle(ctx: ExtensionContext, record: HandleRecord): void {
    if (!record.workflowBinding) return;

    try {
      const finalized = finalizeHandleWorkflow({ cwd: ctx.cwd, handle: record });
      if (!finalized) {
        throw new Error(
          `Workflow finalization returned no record for terminal handle ${record.id}.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = `WORKFLOW_FINALIZATION_FAILED: ${message}`;
      if (!record.errors?.includes(diagnostic)) {
        record.errors = [...(record.errors ?? []), diagnostic];
        writeRecord(ctx.cwd, record);
      }
    }
  }

  private abortError(signal: AbortSignal, fallback: string): ChildRuntimeError {
    const reason = signal.reason;
    if (reason instanceof ChildRuntimeError) return reason;
    return new ChildRuntimeError(
      "ABORTED",
      reason instanceof Error
        ? reason.message
        : typeof reason === "string" && reason.length > 0
          ? reason
          : fallback,
    );
  }

  private async awaitLiveCompletion(
    completion: Promise<AttemptRunResult>,
    signal: AbortSignal,
  ): Promise<AttemptRunResult> {
    if (signal.aborted) {
      throw this.abortError(signal, "Waiting for delegated execution was cancelled.");
    }

    return new Promise<AttemptRunResult>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        cleanup();
        reject(this.abortError(signal, "Waiting for delegated execution was cancelled."));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      completion.then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  private orphanHandle(ctx: ExtensionContext, record: HandleRecord): HandleRecord {
    if (!isTerminalHandleStatus(record.status)) {
      record.status = "orphaned";
      record.errors = [
        ...(record.errors ?? []),
        "ORPHANED_SESSION: no live child run exists for this persisted handle.",
      ];
      writeRecord(ctx.cwd, record);
      this.finalizePersistedHandle(ctx, record);
    }
    return record;
  }

  async poll(ctx: ExtensionContext, id: string): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record || isTerminalHandleStatus(record.status)) return record;
    if (!record.childRunId) return record;

    const live = getChildSessionRegistry().get(record.childRunId);
    return live ? record : this.orphanHandle(ctx, record);
  }

  async awaitHandle(
    ctx: ExtensionContext,
    id: string,
    signal: AbortSignal,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record || isTerminalHandleStatus(record.status)) return record;
    if (!record.childRunId) return record;

    const live = getChildSessionRegistry().get(record.childRunId);
    if (!live) return this.orphanHandle(ctx, record);

    // Cancelling the wait does not cancel the child. Explicit child cancellation
    // remains the responsibility of cancelHandle().
    const result = await this.awaitLiveCompletion(live.completion, signal);
    return result.record as HandleRecord;
  }

  async cancelHandle(
    ctx: ExtensionContext,
    id: string,
    reason: string,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record || isTerminalHandleStatus(record.status)) return record;

    // Persist the terminal state before aborting the live run. The background
    // completion observer checks persisted terminal state and therefore cannot
    // overwrite an explicit cancellation with a generic failure.
    record.status = "cancelled";
    record.errors = [...(record.errors ?? []), reason];
    writeRecord(ctx.cwd, record);

    if (record.childRunId) {
      const registry = getChildSessionRegistry();
      const live = registry.get(record.childRunId);
      if (live) {
        const cancellation = new ChildRuntimeError("ABORTED", reason);
        if (!live.controller.signal.aborted) {
          live.controller.abort(cancellation);
        }
        try {
          await live.run.abort(reason);
        } catch {
          // Provider abort is best-effort after the terminal state is persisted.
        }
        try {
          await live.run.dispose();
        } catch {
          // Disposal is best-effort; the registry entry is removed regardless.
        }
        registry.remove(record.childRunId);
      }
    }

    this.finalizePersistedHandle(ctx, record);
    return record;
  }
}
