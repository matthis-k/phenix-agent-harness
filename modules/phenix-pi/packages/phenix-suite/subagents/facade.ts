import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
    ...(record.value !== undefined ? { value: record.value } : {}),
    ...(record.errors ? { errors: [...record.errors] } : {}),
    modelSet: record.modelSet,
    ...(record.producerSpec
      ? {
          role: record.producerSpec.role,
          agent: record.producerSpec.agent,
          model: record.producerSpec.model,
          thinking: record.producerSpec.thinking,
          tier: record.producerSpec.tier,
        }
      : {}),
  };
}

export function createPhenixSubagentFacade(input: {
  readonly workflow: WorkflowRuntimePort;
  readonly delegator: WorkflowDelegator;
}): PhenixSubagentFacade {
  return {
    workflow: input.workflow,
    inspectHandle(ctx, id) {
      return handle(readRecord(ctx.cwd, effectiveSessionId(ctx), id));
    },
    async pollHandle(ctx, id) {
      return handle(await input.delegator.poll(ctx, id));
    },
    async awaitHandle(ctx, id, signal) {
      return handle(await input.delegator.awaitHandle(ctx, id, signal));
    },
    async cancelHandle(ctx, id, reason) {
      return handle(await input.delegator.cancelHandle(ctx, id, reason));
    },
  };
}
