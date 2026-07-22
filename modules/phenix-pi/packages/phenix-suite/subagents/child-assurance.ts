import { difficultyForProfile } from "@matthis-k/phenix-kernel/task.ts";
import { type AssurancePolicy, assurancePolicyFor } from "../authority/assurance.ts";
import type { AgentRole, TaskProfile, VerificationCommand } from "./agent-types.ts";

function mutationForRole(role: AgentRole): "none" | "local" | "broad" {
  if (role === "implementer") return "local";
  if (role === "finalizer") return "broad";
  return "none";
}

function changeKinds(task: string, requirements: readonly string[]): readonly string[] {
  const text = `${task}\n${requirements.join("\n")}`;
  const kinds: string[] = [];
  for (const kind of ["security", "auth", "secrets", "ci", "deployment", "production", "release"]) {
    if (new RegExp(`\\b${kind}\\b`, "i").test(text)) kinds.push(kind);
  }
  return kinds;
}

export function resolveChildAssurance(input: {
  readonly role: AgentRole;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly profile: TaskProfile;
  readonly verificationCommands: readonly VerificationCommand[];
  readonly criticRequiredByRole: boolean;
}): AssurancePolicy {
  const uncertainty =
    input.profile.uncertainty >= 4 ? "high" : input.profile.uncertainty >= 2 ? "medium" : "low";
  // A role-level critic requirement means independently verified work (A2),
  // not automatically high-risk work (A3). A3 remains driven by impact,
  // secrecy, irreversibility, or an explicit high-assurance request.
  const requestedRigor =
    input.criticRequiredByRole || input.role === "tester" ? "verified" : "normal";
  return assurancePolicyFor({
    userTask: input.task,
    difficulty: difficultyForProfile(input.profile),
    mutation: mutationForRole(input.role),
    changeKinds: changeKinds(input.task, input.requirements),
    uncertainty,
    deterministicChecksAvailable: input.verificationCommands.length > 0,
    userRequestedRigor: requestedRigor,
  });
}
