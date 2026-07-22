import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { executionAuthorityForProject } from "../authority/registry.ts";
import type { WorkflowRuntimePort } from "../runtime/workflow-runtime-types.ts";
import { effectiveSessionId, readRecord } from "./handle-store.ts";
import type { HandleRecord, HandleStatus } from "./handle-types.ts";
import type { WorkflowDelegator } from "./workflow-delegator.ts";

export interface SubagentHandleView {
  readonly id: string;
  readonly subagentId?: string;
  readonly status: HandleStatus;
  readonly value?: unknown;
  readonly errors?: readonly string[];
  readonly modelSet: string;
  readonly role?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly tier?: string;
}

export interface PhenixSubagentFacade {
  readonly workflow: WorkflowRuntimePort;
  inspectHandle(ctx: ExtensionContext, id: string): SubagentHandleView | undefined;
  pollHandle(ctx: ExtensionContext, id: string): Promise<SubagentHandleView | undefined>;
  awaitHandle(
    ctx: ExtensionContext,
    id: string,
    signal: AbortSignal,
  ): Promise<SubagentHandleView | undefined>;
  sendHandle(
    ctx: ExtensionContext,
    id: string,
    message: string,
    signal: AbortSignal,
  ): Promise<SubagentHandleView | undefined>;
  cancelHandle(
    ctx: ExtensionContext,
    id: string,
    reason: string,
  ): Promise<SubagentHandleView | undefined>;
}

function handle(record: HandleRecord | undefined): SubagentHandleView | undefined {
  if (!record) return undefined;
  return {
    id: record.id,
    ...(record.subagentId ? { subagentId: record.subagentId } : {}),
    status: record.status,
    ...(record.value !== undefined
      ? { value: record.value }
      : record.candidateValue !== undefined
        ? { value: record.candidateValue }
        : {}),
    ...(record.errors ? { errors: [...record.errors] } : {}),
    modelSet: record.modelSet,
    ...(record.producerSpec
      ? {
          ...(record.producerSpec.role !== null ? { role: record.producerSpec.role } : {}),
          agent: record.producerSpec.agent,
          model: record.producerSpec.model,
          thinking: record.producerSpec.thinking,
          tier: record.producerSpec.tier,
        }
      : {}),
  };
}

function reconcileAuthority(ctx: ExtensionContext, record: SubagentHandleView | undefined): void {
  if (!record) return;
  const authority = executionAuthorityForProject(ctx.cwd);
  const objective = authority.activeObjectiveForSession(effectiveSessionId(ctx));
  if (!objective) return;
  const snapshot = authority.inspectObjective(objective.id);
  if (!snapshot.handles.some((candidate) => candidate.id === record.id)) return;

  const runtimeState =
    record.status === "completed"
      ? "settled"
      : record.status === "starting"
        ? "starting"
        : record.status;
  let current = snapshot;
  authority.updateHandleRuntime(
    record.id,
    {
      runtimeState,
      ...(record.subagentId ? { childRunId: record.subagentId } : {}),
      ...(record.errors ? { errors: record.errors } : {}),
    },
    {
      idempotencyKey: `handle-reconcile:${record.id}:${record.status}`,
      actorId: "runtime-supervisor",
      expectedRevision: current.objective.revision,
    },
  );

  if (record.status !== "completed") return;
  current = authority.inspectObjective(objective.id);
  const projected = current.handles.find((candidate) => candidate.id === record.id);
  if (projected?.acceptanceState === "pending") {
    authority.submitResult(record.id, record.value, {
      idempotencyKey: `handle-submit:${record.id}`,
      actorId: record.role ?? "producer",
      expectedRevision: current.objective.revision,
    });
  }
  current = authority.inspectObjective(objective.id);
  const submitted = current.handles.find((candidate) => candidate.id === record.id);
  if (submitted && submitted.acceptanceState !== "accepted") {
    authority.decideAcceptance(
      record.id,
      { outcome: "accepted", value: record.value },
      {
        idempotencyKey: `handle-accept:${record.id}`,
        actorId: "acceptance-engine",
        expectedRevision: current.objective.revision,
      },
    );
  }
}

export function createPhenixSubagentFacade(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly delegator: WorkflowDelegator;
}): PhenixSubagentFacade {
  return {
    workflow: input.workflow,
    inspectHandle(ctx, id) {
      const view = handle(readRecord(ctx.cwd, effectiveSessionId(ctx), id));
      reconcileAuthority(ctx, view);
      return view;
    },
    async pollHandle(ctx, id) {
      const view = handle(await input.delegator.poll(ctx, id));
      reconcileAuthority(ctx, view);
      return view;
    },
    async awaitHandle(ctx, id, signal) {
      const view = handle(await input.delegator.awaitHandle(ctx, id, signal));
      reconcileAuthority(ctx, view);
      return view;
    },
    async sendHandle(ctx, id, message, signal) {
      const view = handle(await input.delegator.sendHandle(ctx, id, message, signal));
      reconcileAuthority(ctx, view);
      return view;
    },
    async cancelHandle(ctx, id, reason) {
      const view = handle(await input.delegator.cancelHandle(ctx, id, reason));
      reconcileAuthority(ctx, view);
      return view;
    },
  };
}
