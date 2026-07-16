/** Runtime composition of the authority-bound workflow application service. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ParentExecutionContext } from "../phenix-runtime/workflow-api-types.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowEdgeExecutionResult,
  WorkflowRuntimePort,
  WorkflowTakeEdgeRequest,
} from "../phenix-runtime/workflow-runtime-types.ts";
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

function availableEdges(snapshot: WorkflowAuthoritySnapshot): readonly Record<string, unknown>[] {
  return snapshot.workflow.options.map((edge) => ({
    edgeId: edge.edgeId,
    kind: "spawn",
    fromNodeId: edge.sourceNodeId,
    toNodeId: edge.targetNodeId,
    role: edge.role,
    modes: [...edge.allowedModes],
  }));
}

function failure(message: string, details?: Record<string, unknown>): WorkflowEdgeExecutionResult {
  return { ok: false, message, ...(details ? { details } : {}) };
}

async function takeSpawnEdge(input: {
  readonly request: WorkflowTakeEdgeRequest;
  readonly snapshot: WorkflowAuthoritySnapshot;
  readonly delegator: WorkflowDelegator;
}): Promise<WorkflowEdgeExecutionResult> {
  const edge = input.snapshot.workflow.options.find(
    (candidate) => candidate.edgeId === input.request.edgeId,
  );
  if (!edge) {
    return failure(
      `phenix_workflow: edge "${input.request.edgeId}" is not legal from the current contract-bound node ` +
        `"${input.snapshot.workflow.currentState}".`,
      {
        code: "WORKFLOW_EDGE_NOT_AVAILABLE",
        currentNodeId: input.snapshot.workflow.currentState,
        revision: input.snapshot.workflow.revision,
        availableEdges: availableEdges(input.snapshot),
      },
    );
  }

  if (input.request.input.mode === "background" && input.request.parent?.kind === "child") {
    return failure("phenix_workflow: background spawning is only available to the root actor.");
  }
  if (input.request.input.mode === "background" && !edge.allowedModes.includes("background")) {
    return failure(`phenix_workflow: background mode is not allowed for edge "${edge.edgeId}".`, {
      code: "WORKFLOW_MODE_NOT_ALLOWED",
      edgeId: edge.edgeId,
      allowedModes: [...edge.allowedModes],
    });
  }

  const execution = await input.delegator.delegate({
    params: {
      transitionId: edge.transitionId,
      task: input.request.input.task,
      ...(input.request.input.requirements
        ? { requirements: input.request.input.requirements }
        : {}),
      ...(input.request.input.mode ? { mode: input.request.input.mode } : {}),
      workflowRevision: input.snapshot.workflow.revision,
      authorityDigest: input.snapshot.workflow.optionsDigest,
    },
    ...(input.request.parent ? { parent: input.request.parent } : {}),
    signal: input.request.signal,
    ctx: input.request.ctx,
  });
  if (!execution.ok) return execution;

  return {
    ok: true,
    edge: {
      edgeId: edge.edgeId,
      fromNodeId: edge.sourceNodeId,
      toNodeId: edge.targetNodeId,
    },
    record: execution.record,
  };
}

export function createWorkflowRuntime(input: {
  readonly delegator: WorkflowDelegator;
  readonly maximumDelegationDepth: number;
}): WorkflowRuntimePort {
  const inspect = (request: {
    readonly ctx: ExtensionContext;
    readonly parent?: ParentExecutionContext;
  }): WorkflowAuthoritySnapshot =>
    inspectAuthority({
      ctx: request.ctx,
      ...(request.parent ? { parent: request.parent } : {}),
      maximumDelegationDepth: input.maximumDelegationDepth,
    });

  return {
    inspect,

    async takeEdge(request) {
      const snapshot = inspect(request);
      switch (request.input.kind) {
        case "spawn":
          return takeSpawnEdge({ request, snapshot, delegator: input.delegator });
      }
    },
  };
}
