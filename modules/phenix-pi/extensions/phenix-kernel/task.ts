/**
 * phenix-kernel — shared task semantics
 *
 * One canonical definition of Difficulty, ThinkingLevel, and TaskProfile.
 *
 * Difficulty classification belongs to workflow logic.
 * Routing accepts an already determined difficulty and must
 * no longer classify task profiles itself.
 */

// ── Difficulty ──────────────────────────────────────────────────────────────

export type Difficulty = "D0" | "D1" | "D2" | "D3";

export const ALL_DIFFICULTIES: readonly Difficulty[] = [
  "D0",
  "D1",
  "D2",
  "D3",
];

export function isDifficulty(value: string): value is Difficulty {
  return ["D0", "D1", "D2", "D3"].includes(value);
}

// ── Thinking level ─────────────────────────────────────────────────────────

export type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value);
}

// ── Task profile ────────────────────────────────────────────────────────────

export interface TaskProfile {
  readonly complexity: number;
  readonly uncertainty: number;
  readonly consequence: number;
  readonly breadth: number;
  readonly coupling: number;
  readonly novelty: number;
}

export interface ProfileHint {
  readonly complexity?: number;
  readonly uncertainty?: number;
  readonly consequence?: number;
  readonly breadth?: number;
  readonly coupling?: number;
  readonly novelty?: number;
}

// ── Passive profile derivation ──────────────────────────────────────────────

function clampScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(4, Math.round(value)));
}

function maxScore(...values: Array<number | undefined>): number {
  return Math.max(0, ...values.map((value) => value ?? 0));
}

/**
 * Derive the deterministic Phenix task profile from plain task text.
 *
 * The optional `minimums` parameter lets role-specific policy preserve its
 * existing floor scores without making routing or workflow import subagents.
 */
export function deriveTaskProfileFromText(
  task: string,
  requirements: readonly string[] = [],
  hint: ProfileHint = {},
  minimums: Readonly<Partial<TaskProfile>> = {},
): TaskProfile {
  const text = `${task}\n${requirements.join("\n")}`.toLowerCase();

  const highRisk = /\b(security|auth|permission|secret|credential|migration|data loss|destructive|concurren|race|deadlock|protocol|public api)\b/.test(text);
  const architecture = /\b(architect|redesign|state machine|workflow|persistent|database|schema|interface|cross[- ]cutting)\b/.test(text);
  const uncertainty = /\b(investigate|unknown|unclear|research|diagnose|why|root cause)\b/.test(text);
  const novelty = /\b(new|introduce|design|invent|prototype|replace)\b/.test(text);

  const inferred: TaskProfile = {
    complexity:
      task.length > 4_000 ? 4 : task.length > 1_800 ? 3 : task.length > 700 ? 2 : 1,
    uncertainty: uncertainty ? 2 : 0,
    consequence: highRisk ? 3 : 0,
    breadth: requirements.length >= 9 ? 4 : requirements.length >= 5 ? 3 : requirements.length >= 2 ? 2 : 0,
    coupling: architecture ? 3 : 0,
    novelty: novelty ? 2 : 0,
  };

  return {
    complexity: clampScore(maxScore(inferred.complexity, minimums.complexity, hint.complexity)),
    uncertainty: clampScore(maxScore(inferred.uncertainty, minimums.uncertainty, hint.uncertainty)),
    consequence: clampScore(maxScore(inferred.consequence, minimums.consequence, hint.consequence)),
    breadth: clampScore(maxScore(inferred.breadth, minimums.breadth, hint.breadth)),
    coupling: clampScore(maxScore(inferred.coupling, minimums.coupling, hint.coupling)),
    novelty: clampScore(maxScore(inferred.novelty, minimums.novelty, hint.novelty)),
  };
}

/**
 * Map a deterministic task profile onto the Phenix D0-D3 difficulty scale.
 */
export function difficultyForProfile(profile: TaskProfile): Difficulty {
  const peak = Math.max(...Object.values(profile));
  if (profile.consequence >= 4 || peak >= 4) return "D3";
  if (
    profile.complexity >= 3 ||
    profile.uncertainty >= 3 ||
    profile.consequence >= 3 ||
    profile.coupling >= 3
  ) {
    return "D2";
  }
  if (peak >= 2) return "D1";
  return "D0";
}
