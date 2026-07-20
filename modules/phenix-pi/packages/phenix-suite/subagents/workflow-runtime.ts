/** Runtime composition of the authority-bound workflow application service. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildWorkflowDecisionContext,
  buildWorkflowRuntimeDependencies,
} from "@matthis-k/phenix-flow/index.ts";
import { validateTargetAgentDeterminism } from "@matthis-k/phenix-flow/workflow-target-agents.ts";
import type { WorkflowDefinition } from "@matthis-k/phenix-flow/workflow-types.ts";
import type { ParentExecutionContext } from "../runtime/workflow-api-types.ts";
import type {
  WorkflowAuthoritySnapshot,
  WorkflowRuntimePort,
  WorkflowSpawnRequest,
  WorkflowSpawnResult,
} from "../runtime/workflow-runtime-types.ts";
import { effectiveSessionId, listRecords } from "./handle-store.ts";
import { resolveWorkflowAssignment } from "./workflow-assignment.ts";
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

function availableAgents(snapshot: WorkflowAuthoritySnapshot): readonly Record<string, unknown>[] {
  return snapshot.workflow.options.map((option) => ({
    agent: option.agent,
    role: option.role,
    category: option.category,
    purpose: option.description,
    modes: [...option.allowedModes],
  }));
}

function failure(message: string, details?: Record<string, unknown>): WorkflowSpawnResult {
  return { ok: false, message, ...(details ? { details } : {}) };
}

async function spawnTargetAgent(input: {
  readonly request: WorkflowSpawnRequest;
  readonly snapshot: WorkflowAuthoritySnapshot;
  readonly delegator: WorkflowDelegator;
}): Promise<WorkflowSpawnResult> {
  const matches = input.snapshot.workflow.options.filter(
    (candidate) => candidate.agent === input.request.agent,
  );
  if (matches.length === 0) {
    return failure(
      `phenix_workflow: target agent "${input.request.agent}" is not legal from the current contract-bound node ` +
        `"${input.snapshot.workflow.currentState}".`,
      {
        code: "WORKFLOW_AGENT_NOT_AVAILABLE",
        agent: input.request.agent,
        currentNodeId: input.snapshot.workflow.currentState,
        revision: input.snapshot.workflow.revision,
        availableAgents: availableAgents(input.snapshot),
      },
    );
  }
  if (matches.length > 1) {
    return failure(
      `phenix_workflow: target agent "${input.request.agent}" resolves to multiple legal transitions.`,
      {
        code: "WORKFLOW_AGENT_AMBIGUOUS",
        agent: input.request.agent,
        currentNodeId: input.snapshot.workflow.currentState,
      },
    );
  }

  const option = matches[0];
  if (input.request.mode === "background" && input.request.parent?.kind === "child") {
    return failure("phenix_workflow: background spawning is only available to the root actor.");
  }
  if (input.request.mode === "background" && !option.allowedModes.includes("background")) {
    return failure(
      `phenix_workflow: background mode is not allowed for target agent "${option.agent}".`,
      {
        code: "WORKFLOW_MODE_NOT_ALLOWED",
        agent: option.agent,
        allowedModes: [...option.allowedModes],
      },
    );
  }

  const assignment = resolveWorkflowAssignment({
    source: input.snapshot.source,
    category: option.category,
    transitionDescription: option.description,
    requestedTask: input.request.task,
    ...(input.request.userTask ? { userTask: input.request.userTask } : {}),
    ...(input.request.requirements ? { requestedRequirements: input.request.requirements } : {}),
  });
  const execution = await input.delegator.delegate({
    params: {
      transitionId: option.transitionId,
      task: assignment.task,
      ...(assignment.requirements.length > 0 ? { requirements: [...assignment.requirements] } : {}),
      ...(input.request.mode ? { mode: input.request.mode } : {}),
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
    transition: {
      agent: option.agent,
      fromNodeId: option.sourceNodeId,
      toNodeId: option.targetNodeId,
    },
    record: execution.record,
  };
}

export function createWorkflowRuntime(input: {
  readonly delegator: WorkflowDelegator;
  readonly maximumDelegationDepth: number;
  readonly definitions: readonly WorkflowDefinition[];
}): WorkflowRuntimePort {
  const definitionErrors = input.definitions.flatMap(validateTargetAgentDeterminism);
  if (definitionErrors.length > 0) {
    throw new Error(`Invalid workflow target-agent mapping:\n${definitionErrors.join("\n")}`);
  }

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

    async spawn(request) {
      const snapshot = inspect(request);
      return spawnTargetAgent({ request, snapshot, delegator: input.delegator });
    },
  };
}
