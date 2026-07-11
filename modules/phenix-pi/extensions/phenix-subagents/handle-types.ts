import type { AgentKind, ResolvedExecutionPolicy } from "./policy.ts";
import type { JsonSchema } from "./contracts.ts";
import type { ContractId, RunId } from "./contract.ts";

// ── Constants (used by index.ts; extracted for visibility) ──────────────────

export const HANDLE_VERSION = 1;
export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

// ── Critic contract schema ──────────────────────────────────────────────────

export const CRITIC_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "missingRequirements"],
  properties: {
    verdict: { enum: ["approve", "reject"] },
    summary: { type: "string", minLength: 1 },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "description", "evidence"],
        properties: {
          severity: { enum: ["minor", "major", "critical"] },
          description: { type: "string", minLength: 1 },
          evidence: { type: "string", minLength: 1 },
          requirement: { type: "string" },
        },
      },
    },
    missingRequirements: { type: "array", items: { type: "string", minLength: 1 } },
  },
};

// ── Acceptance ranking ─────────────────────────────────────────────────────

export const ACCEPTANCE_RANK: Record<string, number> = {
  "not-required": 0,
  claimed: 0,
  attested: 1,
  checked: 2,
  verified: 3,
  reviewed: 4,
  accepted: 5,
  rejected: -1,
};

// ── Handle record types ─────────────────────────────────────────────────────

export interface AttemptRecord {
  readonly number: number;
  runId: string;
  readonly phenixRunId: RunId;
  readonly mode: "foreground" | "background";
  readonly startedAt: string;
  readonly contractId: ContractId;
  criticContractId?: ContractId;
  asyncDir?: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  feedback?: string;
  error?: string;
  childSessions?: Array<{
    readonly role: string;
    readonly status: "completed" | "failed";
    readonly sessionFile?: string;
    readonly transcriptPath?: string;
  }>;
}

export interface CriticFinding {
  readonly severity: "minor" | "major" | "critical";
  readonly description: string;
  readonly evidence: string;
  readonly requirement?: string;
}

export interface CriticValue {
  readonly verdict: "approve" | "reject";
  readonly summary: string;
  readonly findings: readonly CriticFinding[];
  readonly missingRequirements: readonly string[];
}

export interface VerificationSummary {
  readonly acceptanceStatus?: string;
  readonly runtimeChecks: readonly string[];
  readonly verifyRuns: readonly string[];
  readonly reviewFindings: readonly string[];
  readonly contract: "valid" | "invalid" | "missing" | "cancelled";
}

export interface HandleRecord {
  readonly version: typeof HANDLE_VERSION;
  readonly id: string;
  readonly sessionId: string;
  readonly parentId?: string;
  readonly role: AgentKind;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly outputSchema: JsonSchema;
  readonly policy: ResolvedExecutionPolicy;
  readonly reviewPolicy?: ResolvedExecutionPolicy;
  readonly createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed" | "cancelled";
  attempts: AttemptRecord[];
  value?: unknown;
  errors?: string[];
  verification?: VerificationSummary;
  review?: {
    readonly verdict: "approve" | "reject";
    readonly summary: string;
    readonly findings: readonly CriticFinding[];
    readonly missingRequirements: readonly string[];
    readonly sessionFile?: string;
    readonly transcriptPath?: string;
  };
}

// ── Evaluation ──────────────────────────────────────────────────────────────

export interface Evaluation {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly errors: readonly string[];
  readonly repairable: boolean;
  readonly verification: VerificationSummary;
  readonly review?: HandleRecord["review"];
}
