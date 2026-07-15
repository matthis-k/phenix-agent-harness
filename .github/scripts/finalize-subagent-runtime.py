from pathlib import Path
import re

root = Path("modules/phenix-pi")
extensions = root / "extensions"
subagents = extensions / "phenix-subagents"
tests = root / "tests"

# Rename modules to their actual responsibilities.
renames = [
    (subagents / "coordinator.ts", subagents / "workflow-delegator.ts"),
    (subagents / "attempt-runner.ts", subagents / "producer-cycle-runner.ts"),
    (subagents / "handle-evaluation.ts", subagents / "producer-contract.ts"),
]
for source, target in renames:
    if source.exists():
        source.rename(target)
    elif not target.exists():
        raise RuntimeError(f"missing source and target for rename: {source}")

# Mechanical vocabulary/path updates are constrained to TypeScript sources.
for path in root.rglob("*.ts"):
    text = path.read_text()
    text = text.replace("./coordinator.ts", "./workflow-delegator.ts")
    text = text.replace(
        "../extensions/phenix-subagents/coordinator.ts",
        "../extensions/phenix-subagents/workflow-delegator.ts",
    )
    text = text.replace("phenix-subagents/coordinator.ts", "phenix-subagents/workflow-delegator.ts")
    text = text.replace("AgentExecutionCoordinatorOptions", "WorkflowDelegatorOptions")
    text = text.replace("AgentExecutionCoordinator", "WorkflowDelegator")
    text = text.replace("./attempt-runner.ts", "./producer-cycle-runner.ts")
    text = text.replace(
        "../extensions/phenix-subagents/attempt-runner.ts",
        "../extensions/phenix-subagents/producer-cycle-runner.ts",
    )
    text = text.replace("./attempt-runner", "./producer-cycle-runner")
    text = text.replace("AttemptRunResult", "ProducerCycleExecutionResult")
    text = text.replace("./handle-evaluation.ts", "./producer-contract.ts")
    text = text.replace("createAttemptContract", "createProducerContract")
    path.write_text(text)

# Rename the runtime-facing coordinator vocabulary only in orchestration adapters.
for relative in [
    "extensions/phenix.ts",
    "extensions/phenix-runtime/delegation-tool.ts",
    "extensions/phenix-subagents/index.ts",
    "extensions/phenix-subagents/workflow-delegator.ts",
]:
    path = root / relative
    text = path.read_text()
    text = re.sub(r"\bDelegationCoordinator\b", "WorkflowDelegatorPort", text)
    text = re.sub(r"\bcoordinator\b", "delegator", text)
    text = re.sub(r"\bCoordinator\b", "Delegator", text)
    path.write_text(text)

# Keep contract issuance as a focused module; remove the unused evaluation/repair API.
producer_contract = subagents / "producer-contract.ts"
producer_contract.write_text('''/** Issue the runtime-owned contract for one producer or critic session. */

import path from "node:path";

import type { ResolvedChildSpec } from "./child-spec.ts";
import {
  type ContractArtifact,
  createRunId,
  issueContract,
  type RunId,
} from "./contract.ts";
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
''')

# Remove the dead ranking and generic evaluation DTO.
handle_types = subagents / "handle-types.ts"
text = handle_types.read_text()
text = re.sub(
    r"\n// ── Acceptance ranking .*?\nexport const ACCEPTANCE_RANK: Record<string, number> = \{.*?\n\};\n",
    "\n",
    text,
    count=1,
    flags=re.S,
)
text = re.sub(
    r"\n// ── Evaluation .*?\nexport interface Evaluation \{.*?\n\}\n",
    "\n",
    text,
    count=1,
    flags=re.S,
)
handle_types.write_text(text)

# Strengthen the architecture assertion around the workflow authority boundary.
architecture = tests / "architecture-boundaries.test.ts"
text = architecture.read_text()
text = text.replace(
    'it("keeps the coordinator independent from managed execution mechanics"',
    'it("keeps the workflow delegator independent from managed execution mechanics"',
)
text = text.replace('"./producer-cycle-runner",', '"./producer-cycle-runner",')
architecture.write_text(text)

# Fail the migration if transitional public names remain in runtime source.
checks = {
    subagents / "workflow-delegator.ts": ["AgentExecutionCoordinator", "createAttemptContract"],
    subagents / "producer-cycle-runner.ts": ["AttemptRunResult", "attempt-runner"],
    subagents / "producer-contract.ts": [
        "evaluateContractResult",
        "repairTask",
        "expectedAcceptanceRank",
        "ACCEPTANCE_RANK",
        "Evaluation",
    ],
    handle_types: ["ACCEPTANCE_RANK", "interface Evaluation"],
    extensions / "phenix-runtime/delegation-tool.ts": ["DelegationCoordinator", "coordinator"],
    subagents / "index.ts": ["AgentExecutionCoordinator", "coordinator"],
}
stale = []
for path, tokens in checks.items():
    content = path.read_text()
    for token in tokens:
        if token in content:
            stale.append(f"{path}: {token}")
if stale:
    raise RuntimeError("transitional subagent vocabulary remains:\n" + "\n".join(stale))
