import { assurancePolicyFor } from "../authority/assurance.ts";
import type { AssuranceLevel } from "../authority/types.ts";
import type { ContractArtifact } from "../subagents/contract.ts";

function mutationForRole(
  role: ContractArtifact["identity"]["role"],
): "none" | "local" | "broad" {
  if (role === "implementer") return "local";
  if (role === "finalizer") return "broad";
  return "none";
}

function changeKinds(contract: ContractArtifact): readonly string[] {
  const text = `${contract.assignment.task}\n${contract.assignment.requirements.join("\n")}`;
  return ["security", "auth", "secrets", "ci", "deployment", "production", "release"].filter(
    (kind) => new RegExp(`\\b${kind}\\b`, "i").test(text),
  );
}

export interface ContractAssuranceProjection {
  readonly assurance: AssuranceLevel;
  readonly isolationRequired: boolean;
}

/**
 * Reconstruct the assurance decision from persisted contract data so SDK/RPC
 * selection is stable across process boundaries and does not depend on critic
 * presence, provider choice, or a process-local registry.
 */
export function assuranceForContract(
  contract: ContractArtifact,
): ContractAssuranceProjection {
  const role = contract.identity.role;
  const policy = assurancePolicyFor({
    userTask: contract.assignment.task,
    difficulty: contract.runtime.workflow.difficulty,
    mutation: mutationForRole(role),
    changeKinds: changeKinds(contract),
    deterministicChecksAvailable: contract.verification.commands.length > 0,
    userRequestedRigor:
      role === "critic"
        ? "normal"
        : contract.verification.criticRequired || role === "tester"
          ? "verified"
          : "normal",
  });
  return { assurance: policy.level, isolationRequired: policy.isolationRequired };
}
