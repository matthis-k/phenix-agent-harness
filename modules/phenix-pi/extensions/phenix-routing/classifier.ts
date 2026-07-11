import type { Difficulty } from "./types.ts";
import type { TaskProfile } from "../phenix-subagents/policy.ts";

/**
 * Map the generic task profile tier to the D0–D3 difficulty scale.
 */
export function difficultyForProfile(profile: TaskProfile): Difficulty {
  const tier = tierForProfile(profile);

  switch (tier) {
    case "low":
      return "D0";
    case "standard":
      return "D1";
    case "high":
      return "D2";
    case "critical":
      return "D3";
  }
}

type ProfileTier = "low" | "standard" | "high" | "critical";

/**
 * Re-export of the existing tier computation from policy.ts.
 * Derived from the same profile values, with escalation rules
 * matching the existing tierForProfile.
 */
function tierForProfile(profile: TaskProfile): ProfileTier {
  const values = [
    profile.complexity,
    profile.uncertainty,
    profile.consequence,
    profile.breadth,
    profile.coupling,
    profile.novelty,
  ];
  const peak = Math.max(...values);

  if (profile.consequence >= 4 || peak >= 4) return "critical";
  if (
    profile.complexity >= 3 ||
    profile.uncertainty >= 3 ||
    profile.consequence >= 3 ||
    profile.coupling >= 3
  ) {
    return "high";
  }
  if (peak >= 2) return "standard";
  return "low";
}

export { tierForProfile as tierForProfilePublic };
export type { ProfileTier };
