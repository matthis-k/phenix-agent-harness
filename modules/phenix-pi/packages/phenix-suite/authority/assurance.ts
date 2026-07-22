import type { AssuranceLevel } from "./types.ts";

export interface AssurancePolicyInput {
  readonly userTask: string;
  readonly difficulty: string;
  readonly mutation?: "none" | "local" | "broad" | "irreversible";
  readonly changeKinds?: readonly string[];
  readonly targetState?: string;
  readonly deterministicChecksAvailable?: boolean;
  readonly uncertainty?: "low" | "medium" | "high";
  readonly userRequestedRigor?: "normal" | "verified" | "high";
}

export interface AssurancePolicy {
  readonly level: AssuranceLevel;
  readonly structuredResultRequired: boolean;
  readonly deterministicVerificationRequired: boolean;
  readonly semanticVerifierRequired: boolean;
  readonly criticRequired: boolean;
  readonly isolationRequired: boolean;
  readonly humanConfirmationRequired: boolean;
  readonly maximumRepairAttempts: number;
  readonly reasons: readonly string[];
}

const HIGH_RISK_KINDS = new Set([
  "security",
  "auth",
  "authentication",
  "secrets",
  "ci",
  "deployment",
  "production",
  "release",
]);

function taskRequestsQa(task: string): boolean {
  return /\b(?:full\s+qa|quality[- ]assurance|independent\s+review|audit|verify|verification)\b/i.test(
    task,
  );
}

function taskIsDirect(task: string): boolean {
  return /^(?:explain|define|summarize|translate|what\s+is|why\s+does|how\s+does)\b/i.test(
    task.trim(),
  );
}

export function assurancePolicyFor(input: AssurancePolicyInput): AssurancePolicy {
  const reasons: string[] = [];
  const changeKinds = new Set((input.changeKinds ?? []).map((kind) => kind.toLowerCase()));
  const highRiskKind = [...changeKinds].some((kind) => HIGH_RISK_KINDS.has(kind));
  const highImpact =
    highRiskKind ||
    input.mutation === "irreversible" ||
    input.targetState === "main-bound" ||
    input.userRequestedRigor === "high";

  let level: AssuranceLevel;
  if (highImpact) {
    level = "A3";
    reasons.push("high-impact or security-sensitive change");
  } else if (
    taskRequestsQa(input.userTask) ||
    input.userRequestedRigor === "verified" ||
    input.mutation === "broad" ||
    input.uncertainty === "high" ||
    input.difficulty === "D3"
  ) {
    level = "A2";
    reasons.push("independent evidence is required");
  } else if (
    input.mutation === "local" ||
    input.difficulty === "D1" ||
    input.difficulty === "D2" ||
    !taskIsDirect(input.userTask)
  ) {
    level = "A1";
    reasons.push("bounded contracted execution is appropriate");
  } else {
    level = "A0";
    reasons.push("low-impact direct execution is sufficient");
  }

  if (input.uncertainty === "high" && level === "A1") level = "A2";
  if (!input.deterministicChecksAvailable && level === "A2") {
    reasons.push("semantic verification substitutes for unavailable deterministic checks");
  }

  return {
    level,
    structuredResultRequired: level !== "A0",
    deterministicVerificationRequired:
      (level === "A2" || level === "A3") && input.deterministicChecksAvailable !== false,
    semanticVerifierRequired:
      level === "A3" || (level === "A2" && input.deterministicChecksAvailable === false),
    criticRequired: level === "A3",
    isolationRequired: level === "A3",
    humanConfirmationRequired: level === "A3" && input.mutation === "irreversible",
    maximumRepairAttempts: level === "A3" ? 2 : level === "A2" ? 1 : 0,
    reasons,
  };
}
