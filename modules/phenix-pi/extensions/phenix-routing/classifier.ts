import type { Difficulty, TaskProfile } from "../phenix-kernel/task.ts";
import { difficultyForProfile as kernelDifficultyForProfile } from "../phenix-kernel/task.ts";

/**
 * Map the generic task profile onto the D0–D3 difficulty scale.
 *
 * New code should import this from phenix-kernel/task.ts directly; this module
 * remains routing-owned only as the historical test/import surface.
 */
export function difficultyForProfile(profile: TaskProfile): Difficulty {
  return kernelDifficultyForProfile(profile);
}
