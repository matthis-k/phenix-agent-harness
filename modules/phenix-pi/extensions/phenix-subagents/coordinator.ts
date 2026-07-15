/**
 * coordinator — Phenix workflow delegation coordinator
 *
 * Owns workflow authority, transition settlement, handle persistence, and
 * foreground/background orchestration. Child execution is performed through a
 * workflow-scoped SubagentManager; backend and session details stay below the
 * runtime adapter boundary.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../phenix-kernel/agents.ts";
import { modelSetId } from "../phenix-kernel/ids.ts";
import { modelSetForModelId, PHENIX_PROVIDER } from "../phenix-routing/provider.ts";
import type { LiveChildRunRecord } from "../phenix-runtime/child-session-registry.ts";
import { getChildSessionRegistry } from "../phenix-runtime/child-session-registry.ts";
import { ChildRuntimeError, childRunId } from "../phenix-runtime/child-session-types.ts";
import { ContractSubmissionChannelImpl } from "../phenix-runtime/contract-channel.ts";
import type {
  DelegateExecutionParams,
  ParentExecutionContext,
} from "../phenix-runtime/delegation-tool.ts";
import type { SubagentManagerFactory } from "../phenix-runtime/subagent-manager-factory.ts";
import {
  type SubagentCancellation,
  SubagentExecutionError,
  type SubagentHandle,
} from "../phenix-runtime/subagent-manager.ts";
import {
  buildWorkflowDecisionContext,
  buildWorkflowRuntimeDependencies,
  getOutputSchema,
  PHENIX_DEFAULT_WORKFLOW,
} from "../phenix-workflow/index.ts";
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
import type { HandleRecord, WorkflowBinding } from "./handle-types.ts";
import { HANDLE_VERSION, isTerminalHandleStatus } from "./handle-types.ts";
import type { WorkflowProducerAcceptanceData } from "./workflow-acceptance-engine.ts";
import { createWorkflowExecutionCompiler } from "./workflow-execution-compiler.ts";

export type DelegateExecutionResult =
  | { readonly ok: true; readonly record: HandleRecord }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

interface ManagedCompletion {
  readonly record: HandleRecord;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

function createHandle(input: {
  readonly id: string;
  readonly sessionId: string;
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

function executionError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof SubagentExecutionError || error instanceof ChildRuntimeError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "SUBAGENT_EXECUTION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function cancellationFromSignal(signal: AbortSignal, fallback: string): SubagentCancellation {
  const reason = signal.reason;
  if (reason instanceof SubagentExecutionError || reason instanceof ChildRuntimeError) {
    return { code: reason.code, reason: reason.message };
  }
  return {
    code: "ABORTED",
    reason:
      reason instanceof Error
        ? reason.message
        : typeof reason === "string" && reason.length > 0
          ? reason
          : fallback,
  };
}

export interface AgentExecutionCoordinatorOptions {
  readonly managers: SubagentManagerFactory;
  readonly activeModelSet: string;
  readonly maximumDelegationDepth: number;
}

export class AgentExecutionCoordinator {
  private readonly managers: SubagentManagerFactory;
  private readonly activeModelSet: string;
  private readonly maximumDelegationDepth: number;

  constructor(options: AgentExecutionCoordinatorOptions) {
    this.managers = options.managers;
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

  private async delegateInternal(input: {
    readonly params: DelegateExecutionParams;
    readonly ctx: ExtensionContext;
    readonly signal: AbortSignal;
    readonly parent?: ParentExecutionContext;
  }): Promise<DelegateExecutionResult> {
    const { params, ctx, signal } = input;

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
    const invocationSessionId = effectiveSessionId(ctx);
    const parent = input.parent ?? {
      kind: "root" as const,
      sessionId: invocationSessionId,
      cwd: ctx.cwd,
      maximumDelegationDepth: this.maximumDelegationDepth,
    };
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

    let workflowRecord = dependencies.record;
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

    if (params.workflowRevision !== workflowRecord.revision) {
      return {
        ok: false,
        message:
          `phenix_delegate: stale workflow revision. Expected ${params.workflowRevision}, current ${workflowRecord.revision}. ` +
          `Current state: ${workflowRecord.state}. Refresh delegation options before attempting again.`,
        details: {
          currentState: workflowRecord.state,
          currentRevision: workflowRecord.revision,
        },
      };
    }

    const transitionId = params.transitionId as WorkflowTransitionId;
    const matchingOption = decision.options.find((option) => option.transitionId === transitionId);
    if (!matchingOption) {
      const availableIds = decision.options.map((option) => option.transitionId).join(", ");
      return {
        ok: false,
        message:
          `phenix_delegate: transition "${params.transitionId}" is not currently available. ` +
          `State: ${workflowRecord.state}, Difficulty: ${workflowRecord.difficulty}. ` +
          `Available transitions: ${availableIds || "(none)"}`,
        details: {
          state: workflowRecord.state,
          difficulty: workflowRecord.difficulty,
          available: decision.options.map((option) => ({
            id: option.transitionId,
            role: option.role,
            category: option.category,
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

    const transition = PHENIX_DEFAULT_WORKFLOW.transitions.find((item) => item.id === transitionId);
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

    const handleId = randomUUID();
    const childActorId = `actor_${handleId}`;
    const instanceId = workflowRecord.instanceId;
    const sourceStateBefore = workflowRecord.state;
    const sourceRevisionBefore = workflowRecord.revision;

    let executionId: string;
    try {
      const result = beginTransition(ctx.cwd, workflowRecord, {
        expectedRevision: sourceRevisionBefore,
        transitionId: transition.id,
        handleId,
      });
      workflowRecord = result.record;
      executionId = result.executionId;
    } catch (error) {
      if (error instanceof WorkflowStoreError) {
        return {
          ok: false,
          message: `phenix_delegate: workflow error [${error.code}]: ${error.message}`,
          details: { code: error.code, ...error.context } as Record<string, unknown>,
        };
      }
      throw error;
    }

    const rejectStartedTransition = (): boolean => {
      try {
        rejectTransition(ctx.cwd, workflowRecord, {
          executionId,
          nextState: transition.onRejected,
        });
        return true;
      } catch {
        return false;
      }
    };

    const finalizeOrRejectHandle = (handle: HandleRecord): void => {
      let finalizationError: unknown = new Error(
        `Workflow finalization returned no record for handle ${handle.id}.`,
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const finalized = finalizeHandleWorkflow({ cwd: ctx.cwd, handle });
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

    let ownedHandle: SubagentHandle<unknown> | undefined;
    let cleanupOwnedScope: (() => void) | undefined;
    try {
      const role = roleForAgentClient(transition.agentClient);
      const childInitialState = initialWorkflowStateForRole(role);
      const childRuntimeRecord = createWorkflowRecord(ctx.cwd, {
        instanceId,
        actorId: childActorId,
        parentActorId: workflowRecord.actorId,
        sessionId,
        definitionId: workflowRecord.definitionId,
        difficulty: workflowRecord.difficulty,
        taskProfile: workflowRecord.taskProfile,
        actorRole: actorRoleForAgentClient(transition.agentClient),
        initialState: childInitialState,
        capabilityArtifactHash: workflowRecord.capabilityArtifactHash,
      });

      const outputSchema = getOutputSchema(outputSchemaIdForContract(transition.outputContract));
      const childWorkflow: ResolvedWorkflowChildInput = {
        instanceId,
        actorId: childActorId,
        parentActorId: workflowRecord.actorId,
        definitionId: workflowRecord.definitionId,
        definitionVersion: 1,
        difficulty: workflowRecord.difficulty,
        initialState: childInitialState,
        transitionAuthority: transitionAuthorityForChild({
          definition: dependencies.definition,
          role,
          initialState: childInitialState,
          authorizedRoles: dependencies.authority.roles.effective,
        }),
        capabilityArtifactHash: workflowRecord.capabilityArtifactHash,
      };

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
        capabilityArtifact: dependencies.capabilities,
        workflow: childWorkflow,
      });

      let criticSpec: ResolvedChildSpec | undefined;
      if (producerSpec.criticRequired) {
        const criticWorkflow: ResolvedWorkflowChildInput = {
          instanceId,
          actorId: `critic_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          parentActorId: childActorId,
          definitionId: workflowRecord.definitionId,
          definitionVersion: 1,
          difficulty: workflowRecord.difficulty,
          initialState: "reviewing",
          transitionAuthority: { kind: "restricted", allowed: [] },
          capabilityArtifactHash: workflowRecord.capabilityArtifactHash,
        };
        criticSpec = resolveChildSpec({
          role: "critic",
          task: `Review the completed handoff: ${params.task.slice(0, 200)}`,
          requirements,
          outputSchema: getOutputSchema("critic-handoff"),
          tools: null,
          delegateRoles: null,
          cwd: ctx.cwd,
          creator: { kind: "runtime-internal", maximumDelegationDepth: 0 },
          capabilityArtifact: dependencies.capabilities,
          workflow: criticWorkflow,
        });
      }

      const workflowBinding: WorkflowBinding = {
        instanceId,
        actorId: workflowRecord.actorId,
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

      const issuedContract = await createAttemptContract({
        spec: producerSpec,
        assignment: { task: params.task, requirements, outputSchema },
        identity: { handleId: record.id, parentHandleId: record.parentId },
        cwd: ctx.cwd,
      });
      const contractArtifact = issuedContract.artifact;
      const contractChannel = new ContractSubmissionChannelImpl(
        new FileContractStore(
          path.join(findProjectRoot(ctx.cwd), ".phenix-agent-state", "contracts"),
        ),
        contractArtifact,
      );
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

      const childRunIdValue = childRunId(`child_${record.id}`);
      const parentRunId =
        parent.kind === "child" && parent.childRunId ? childRunId(parent.childRunId) : undefined;
      const rootRunId =
        parent.kind === "child" && parent.rootChildRunId
          ? childRunId(parent.rootChildRunId)
          : childRunIdValue;
      const acceptanceData: WorkflowProducerAcceptanceData = {
        record,
        contractArtifact,
        contractChannel,
        cwd: ctx.cwd,
        maximumProducerCycles: producerSpec.maxRepairAttempts + 1,
        completionGraceRemaining: 1,
      };
      const executionCompiler = createWorkflowExecutionCompiler({
        role,
        modelSet: modelSetId(selectedModelSet),
        difficulty: workflowRecord.difficulty,
        thinking: producerSpec.thinking,
        persistence: "file",
        runtime: {
          id: childRunIdValue,
          ...(parentRunId ? { parentId: parentRunId } : {}),
          rootId: rootRunId,
          handleId: record.id,
          cwd: ctx.cwd,
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
            childRunId: childRunIdValue,
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
        },
        acceptanceKind: "workflow-producer",
        acceptanceData,
      });

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
        if (signal.aborted) abortFromParent();
        else signal.addEventListener("abort", abortFromParent, { once: true });
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

      const manager = this.managers.create(executionCompiler);
      let handle: SubagentHandle<unknown>;
      try {
        handle = await manager.spawn(
          {
            task: params.task,
            requirements,
            returns: { schema: outputSchema },
          },
          runController.signal,
        );
      } catch (error) {
        if (!isBackground) signal.removeEventListener("abort", abortFromParent);
        if (executionTimeout) clearTimeout(executionTimeout);
        const normalized = executionError(error);
        record.status = normalized.code === "ABORTED" ? "cancelled" : "failed";
        record.errors = [`${normalized.code}: ${normalized.message}`];
        writeRecord(ctx.cwd, record);
        finalizeOrRejectHandle(record);
        return {
          ok: false,
          message: `phenix_delegate: child session start failed: ${normalized.message}`,
          details: { code: normalized.code },
        };
      }
      ownedHandle = handle;

      const cancelFromScope = (): void => {
        void handle.cancel(
          cancellationFromSignal(runController.signal, "Delegated execution was cancelled."),
        );
      };
      if (runController.signal.aborted) cancelFromScope();
      else runController.signal.addEventListener("abort", cancelFromScope, { once: true });

      const cleanupScope = (): void => {
        if (!isBackground) signal.removeEventListener("abort", abortFromParent);
        runController.signal.removeEventListener("abort", cancelFromScope);
        if (executionTimeout) {
          clearTimeout(executionTimeout);
          executionTimeout = undefined;
        }
      };
      cleanupOwnedScope = cleanupScope;

      record.childRunId = handle.id;
      record.rootChildRunId = rootRunId;
      record.status = "running";
      writeRecord(ctx.cwd, record);

      const completion: Promise<ManagedCompletion> = handle.result().then(
        () => ({ record: readRecord(ctx.cwd, sessionId, handleId) ?? record }),
        (error) => {
          const normalized = executionError(error);
          const failedRecord = readRecord(ctx.cwd, sessionId, handleId) ?? record;
          if (!isTerminalHandleStatus(failedRecord.status)) {
            failedRecord.status = normalized.code === "ABORTED" ? "cancelled" : "failed";
            failedRecord.errors = [`${normalized.code}: ${normalized.message}`];
            writeRecord(ctx.cwd, failedRecord);
          }
          return { record: failedRecord, error: normalized };
        },
      ).finally(() => {
        cleanupScope();
        ownedHandle = undefined;
        cleanupOwnedScope = undefined;
      });

      if (isBackground) {
        const liveRecord: LiveChildRunRecord = { handle, completion };
        getChildSessionRegistry().add(liveRecord);
        void completion
          .then((settled) => finalizeOrRejectHandle(settled.record))
          .finally(() => getChildSessionRegistry().remove(handle.id))
          .catch(() => undefined);
        return { ok: true, record };
      }

      const settled = await completion;
      finalizeOrRejectHandle(settled.record);
      if (settled.record.status !== "completed") {
        return {
          ok: false,
          message: settled.error?.message ?? "Delegated child execution failed.",
          details: {
            code: settled.error?.code ?? "CHILD_EXECUTION_FAILED",
            handleId: settled.record.id,
            status: settled.record.status,
          },
        };
      }
      return { ok: true, record: settled.record };
    } catch (error) {
      cleanupOwnedScope?.();
      if (ownedHandle) {
        try {
          await ownedHandle.cancel("delegation execution failed");
        } catch {
          // Best-effort managed cancellation.
        }
      }

      const failedRecord = readRecord(ctx.cwd, sessionId, handleId);
      if (failedRecord) {
        if (!isTerminalHandleStatus(failedRecord.status)) {
          const normalized = executionError(error);
          failedRecord.status = normalized.code === "ABORTED" ? "cancelled" : "failed";
          failedRecord.errors = [`${normalized.code}: ${normalized.message}`];
          writeRecord(ctx.cwd, failedRecord);
        }
        finalizeOrRejectHandle(failedRecord);
      } else {
        rejectStartedTransition();
      }

      const normalized = executionError(error);
      return {
        ok: false,
        message: `phenix_delegate: execution failed: ${normalized.message}`,
        details: {
          code: normalized.code,
          ...(failedRecord ? { handleId: failedRecord.id } : {}),
        },
      };
    }
  }

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

  private async awaitLiveCompletion(
    completion: Promise<unknown>,
    signal: AbortSignal,
  ): Promise<ManagedCompletion> {
    if (signal.aborted) {
      throw new ChildRuntimeError("ABORTED", "Waiting for delegated execution was cancelled.");
    }

    return new Promise<ManagedCompletion>((resolve, reject) => {
      const cleanup = (): void => signal.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        cleanup();
        reject(new ChildRuntimeError("ABORTED", "Waiting for delegated execution was cancelled."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      completion.then(
        (result) => {
          cleanup();
          resolve(result as ManagedCompletion);
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
        "ORPHANED_SESSION: no live managed subagent exists for this persisted handle.",
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
    return getChildSessionRegistry().get(record.childRunId)
      ? record
      : this.orphanHandle(ctx, record);
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
    return (await this.awaitLiveCompletion(live.completion, signal)).record;
  }

  async cancelHandle(
    ctx: ExtensionContext,
    id: string,
    reason: string,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(ctx.cwd, effectiveSessionId(ctx), id);
    if (!record || isTerminalHandleStatus(record.status)) return record;

    record.status = "cancelled";
    record.errors = [...(record.errors ?? []), reason];
    writeRecord(ctx.cwd, record);

    if (record.childRunId) {
      const registry = getChildSessionRegistry();
      const live = registry.get(record.childRunId);
      if (live) {
        try {
          await live.handle.cancel(reason);
        } finally {
          registry.remove(record.childRunId);
        }
      }
    }

    this.finalizePersistedHandle(ctx, record);
    return record;
  }
}
