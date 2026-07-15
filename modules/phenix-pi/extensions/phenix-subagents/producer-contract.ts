/** Issue the runtime-owned contract for one producer or critic session. */

import path from "node:path";

import type { ResolvedChildSpec } from "./child-spec.ts";
import { type ContractArtifact, createRunId, issueContract, type RunId } from "./contract.ts";
import { FileContractStore } from "./contract-store.ts";
import { findProjectRoot } from "./handle-store.ts";

function contractsForCwd(cwd: string): FileContractStore {
  return new FileContractStore(path.join(findProjectRoot(cwd), ".phenix-agent-state", "contracts"));
}

export async function createProducerContract(input: {
  readonly spec: ResolvedChildSpec;
  readonly assignment: {
    readonly task: string;
    readonly requirements: readonly string[];
    readonly outputSchema: Record<string, unknown>;
  };
  readonly identity: {
    readonly handleId: string;
    readonly parentHandleId?: string;
    readonly parentRunId?: RunId;
  };
  readonly cwd: string;
}): Promise<{
  readonly artifact: ContractArtifact;
  readonly capabilityToken: string;
  readonly phenixRunId: RunId;
}> {
  const phenixRunId = createRunId();

  const issued = issueContract({
    identity: {
      runId: phenixRunId,
      handleId: input.identity.handleId,
      ...(input.identity.parentHandleId ? { parentHandleId: input.identity.parentHandleId } : {}),
      ...(input.identity.parentRunId ? { parentRunId: input.identity.parentRunId } : {}),
      role: input.spec.role,
    },
    assignment: {
      task: input.assignment.task,
      requirements: input.assignment.requirements,
      outputSchema: input.assignment.outputSchema,
    },
    runtime: {
      agent: input.spec.agent,
      cwd: input.cwd,
      model: input.spec.model,
      thinking: input.spec.thinking,
      tools: input.spec.tools,
      skills: input.spec.skills,
      extensions: input.spec.extensions,
      delegation: {
        roles: input.spec.delegation.roles,
        availableRoles: input.spec.delegation.availableRoles,
        remainingDepth: input.spec.delegation.remainingDepth,
      },
      workflow: {
        instanceId: input.spec.workflow.instanceId,
        actorId: input.spec.workflow.actorId,
        ...(input.spec.workflow.parentActorId
          ? { parentActorId: input.spec.workflow.parentActorId }
          : {}),
        definitionId: input.spec.workflow.definitionId,
        definitionVersion: input.spec.workflow.definitionVersion,
        difficulty: input.spec.workflow.difficulty,
        initialState: input.spec.workflow.initialState,
        transitionAuthority: input.spec.workflow.transitionAuthority,
        capabilityArtifactHash: input.spec.workflow.capabilityArtifactHash,
      },
      timeoutMs: input.spec.timeoutMs,
      turnBudget: input.spec.turnBudget,
      toolBudget: input.spec.toolBudget,
    },
    verification: {
      commands: input.spec.verificationCommands,
      criticRequired: input.spec.criticRequired,
      maxRepairAttempts: input.spec.maxRepairAttempts,
    },
  });

  await contractsForCwd(input.cwd).create(issued.artifact);

  return {
    artifact: issued.artifact,
    capabilityToken: issued.capabilityToken,
    phenixRunId,
  };
}
