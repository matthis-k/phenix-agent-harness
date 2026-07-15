/**
 * coordinator — Phenix workflow delegation coordinator
 *
 * Owns workflow authority, transition settlement, handle persistence, and
 * foreground/background lifecycle. Session construction is delegated to the
 * canonical session runtime; deterministic verification and critic execution
 * are delegated to ExecutionQualityService.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRole } from "../phenix-kernel/agents.ts";
import { modelSetId } from "../phenix-kernel/ids.ts";
import { modelSetForModelId, PHENIX_PROVIDER } from "../phenix-routing/provider.ts";
import type {
  AttemptRunResult,
  LiveChildRunRecord,
} from "../phenix-runtime/child-session-registry.ts";
import { getChildSessionRegistry } from "../phenix-runtime/child-session-registry.ts";
import type {
  ChildRun,
  ChildSessionBackend,
} from "../phenix-runtime/child-session-types.ts";
import {
  ChildRuntimeError,
  childRunId,
} from "../phenix-runtime/child-session-types.ts";
import { ContractSubmissionChannelImpl } from "../phenix-runtime/contract-channel.ts";
import type {
  DelegateExecutionParams,
  ParentExecutionContext,
} from "../phenix-runtime/delegation-tool.ts";
import type { SubagentSessionRuntime } from "../phenix-runtime/subagent-session-runtime.ts";
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
import type { ExecutionQualityService } from "./execution-quality-service.ts";
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
import { createWorkflowExecutionCompiler } from "./workflow-execution-compiler.ts";

export type DelegateExecutionResult =
  | { readonly ok: true; readonly record: HandleRecord }
  | {
      readonly ok: false;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

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

export interface AgentExecutionCoordinatorOptions {
  readonly backend: ChildSessionBackend;
  readonly sessionRuntime: SubagentSessionRuntime;
  readonly quality: ExecutionQualityService;
  readonly activeModelSet: string;
  readonly maximumDelegationDepth: number;
}

export class AgentExecutionCoordinator {
  private readonly backend: ChildSessionBackend;
  private readonly sessionRuntime: SubagentSessionRuntime;
  private readonly quality: ExecutionQualityService;
  private readonly activeModelSet: string;
  private readonly maximumDelegationDepth: number;

  constructor(options: AgentExecutionCoordinatorOptions) {
    this.backend = options.backend;
    this.sessionRuntime = options.sessionRuntime;
    this.quality = options.quality;
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
    const matchingOption = decision.options.find((option) => option.transitionId === transitionId);
    if (!matchingOption) {
      const availableIds = decision.options.map((option) => option.transitionId).join(", ");
      return {
        ok: false,
        message:
          `phenix_delegate: transition "${params.transitionId}" is not currently available. ` +
          `State: ${wfRecord.state}, Difficulty: ${wfRecord.difficulty}. ` +
          `Available transitions: ${availableIds || "(none)"}`,
        details: {
          state: wfRecord.state,
          difficulty: wfRecord.difficulty,
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
        rejectTransition(ctx.cwd, wfRecord, {
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

    let ownedRun: ChildRun | undefined;
    let cleanupOwnedRunScope: (() => void) | undefined;
    try {
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

      let criticSpec: ResolvedChildSpec | undefined;
      if (producerSpec.criticRequired) {
        const criticTask = `Review the completed handoff: ${params.task.slice(0, 200)}`;
        const criticWorkflow: ResolvedWorkflowChildInput = {
          instanceId,
          actorId: `critic_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
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
          outputSchema: getOutputSchema("critic-handoff"),
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

      const childRunIdValue = childRunId(`child_${record.id}`);
      const parentRunId =
        parent.kind === "child" && parent.childRunId ? childRunId(parent.childRunId) : undefined;
      const rootRunId =
        parent.kind === "child" && parent.rootChildRunId
          ? childRunId(parent.rootChildRunId)
          : childRunIdValue;
      const executionCompiler = createWorkflowExecutionCompiler({
        role,
        modelSet: modelSetId(selectedModelSet),
        difficulty: wfRecord.difficulty,
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
        acceptanceData: { handleId: record.id },
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

      const cleanupRunScope = (): void => {
        if (!isBackground) signal.removeEventListener("abort", abortFromParent);
        if (executionTimeout) {
          clearTimeout(executionTimeout);
          executionTimeout = undefined;
        }
      };
      cleanupOwnedRunScope = cleanupRunScope;
      const runSignal = runController.signal;

      let run: ChildRun;
      try {
        const executionPlan = await executionCompiler.compile(
          {
            task: params.task,
            requirements,
            returns: { schema: outputSchema },
          },
          runSignal,
        );
        run = await this.sessionRuntime.spawn(executionPlan, runSignal);
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
      record.childRunId = run.id;
      record.rootChildRunId = run.snapshot().rootId;
      record.backend = run.backend;
      record.piSessionId = run.pi.sessionId;
      record.piSessionFile = run.pi.sessionFile;
      record.status = "running";
      writeRecord(ctx.cwd, record);

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
            verify: (verificationInput) => this.quality.verify(verificationInput),
            criticFactory: (_backend, criticInput) => this.quality.review(criticInput),
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
        const completionPromise = executeCycles();
        const liveRecord: LiveChildRunRecord = {
          run,
          completion: completionPromise,
          controller: runController,
        };
        getChildSessionRegistry().add(liveRecord);
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

    record.status = "cancelled";
    record.errors = [...(record.errors ?? []), reason];
    writeRecord(ctx.cwd, record);

    if (record.childRunId) {
      const registry = getChildSessionRegistry();
      const live = registry.get(record.childRunId);
      if (live) {
        const cancellation = new ChildRuntimeError("ABORTED", reason);
        if (!live.controller.signal.aborted) live.controller.abort(cancellation);
        try {
          await live.run.abort(reason);
        } catch {
          // Provider abort is best-effort after terminal persistence.
        }
        try {
          await live.run.dispose();
        } catch {
          // Disposal is best-effort; registry removal is authoritative.
        }
        registry.remove(record.childRunId);
      }
    }

    this.finalizePersistedHandle(ctx, record);
    return record;
  }
}
