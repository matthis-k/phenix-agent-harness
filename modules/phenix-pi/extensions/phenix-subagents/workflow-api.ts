/** Runtime composition of the model-facing workflow API. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
  WorkflowApiPort,
  WorkflowAuthoritySnapshot,
} from "../phenix-runtime/workflow-api-tools.ts";
import type { ParentExecutionContext } from "../phenix-runtime/workflow-api-types.ts";
import {
  buildWorkflowDecisionContext,
  buildWorkflowRuntimeDependencies,
} from "../phenix-workflow/index.ts";
import { effectiveSessionId, listRecords } from "./handle-store.ts";
import type { WorkflowDelegator } from "./workflow-delegator.ts";

function inspectAuthority(input: {
  readonly ctx: ExtensionContext;
  readonly parent?: ParentExecutionContext;
  readonly maximumDelegationDepth: number;
}): WorkflowAuthoritySnapshot {
  const invocationSessionId = effectiveSessionId(input.ctx);
  const parent = input.parent ?? {
    kind: "root" as const,
    sessionId: invocationSessionId,
    cwd: input.ctx.cwd,
    maximumDelegationDepth: input.maximumDelegationDepth,
  };
  const sessionId = parent.kind === "child" ? parent.sessionId : invocationSessionId;
  const source =
    parent.kind === "child"
      ? ({ kind: "child", contract: parent.contract } as const)
      : ({ kind: "root", sessionId } as const);
  const dependencies = buildWorkflowRuntimeDependencies({
    cwd: input.ctx.cwd,
    sessionId,
    source,
    handleStore: { listRecords },
  });
  const workflow = buildWorkflowDecisionContext({
    definition: dependencies.definition,
    runtime: dependencies.record,
    authority: dependencies.authority,
    activeHandles: dependencies.activeHandles,
  });

  return {
    source: parent.kind === "child" ? "contract" : "root",
    role: parent.kind === "child" ? (parent.contract.identity.role ?? "base") : "coordinator",
    effectiveTools: parent.kind === "child" ? [...parent.contract.runtime.tools.effective] : [],
    delegation: {
      remainingDepth: dependencies.authority.remainingDepth,
      effectiveRoles: dependencies.authority.roles.effective
        .filter((role): role is Exclude<typeof role, null> => role !== null)
        .map(String),
      availableRoles: dependencies.authority.availableRoles
        .filter((role): role is Exclude<typeof role, null> => role !== null)
        .map(String),
    },
    workflow,
  };
}

export function createWorkflowApi(input: {
  readonly delegator: WorkflowDelegator;
  readonly maximumDelegationDepth: number;
}): WorkflowApiPort {
  return {
    inspect: ({ ctx, parent }) =>
      inspectAuthority({
        ctx,
        ...(parent ? { parent } : {}),
        maximumDelegationDepth: input.maximumDelegationDepth,
      }),
    delegate: (request) => input.delegator.delegate(request),
  };
}
