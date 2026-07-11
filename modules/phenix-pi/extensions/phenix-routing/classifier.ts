import type { Difficulty } from "./types.ts";
import { tierForProfile } from "../phenix-subagents/policy.ts";
import type { TaskProfile } from "../phenix-subagents/policy.ts";

/**
 * Map the generic task profile tier to the D0–D3 difficulty scale.
 * Uses tierForProfile from the authoritative policy module.
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
