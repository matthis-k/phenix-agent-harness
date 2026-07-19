import type { JsonSchema } from "@matthis-k/phenix-contracts/definitions.ts";
import type {
  WorkflowStateId,
  WorkflowTransitionId,
} from "@matthis-k/phenix-flow/workflow-types.ts";
import type { SerializedError } from "../runtime/child-session-types.ts";
import type { AgentRole } from "./agent-types.ts";
import type { ResolvedChildSpec } from "./child-spec.ts";

// ── Constants (used by index.ts; extracted for visibility) ──────────────────

/** Persisted lifecycle states for a delegated handle. */
export type HandleStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "orphaned";

/** States after which neither producer execution nor workflow settlement may restart. */
export const TERMINAL_STATES: ReadonlySet<HandleStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "orphaned",
]);

export function isTerminalHandleStatus(status: HandleStatus): boolean {
  return TERMINAL_STATES.has(status);
}

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

// ── Producer cycle record ───────────────────────────────────────────────────

export interface ProducerCycleRecord {
  readonly number: number;
  readonly startedAt: string;
  endedAt?: string;

  contractRevision: number;
  status: "running" | "submitted" | "rejected" | "accepted" | "failed" | "cancelled";

  feedback?: string;
  verification?: VerificationSummary;
  critic?: CriticSummary;
  error?: SerializedError;
}

export interface CriticSummary {
  readonly verdict: "approve" | "reject";
  readonly summary: string;
  readonly findings: readonly CriticFinding[];
  readonly missingRequirements: readonly string[];
}

// ── Critic types ────────────────────────────────────────────────────────────

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

// ── Verification summary ────────────────────────────────────────────────────

export interface VerificationSummary {
  readonly acceptanceStatus?: string;
  readonly runtimeChecks: readonly string[];
  readonly verifyRuns: readonly string[];
  readonly reviewFindings: readonly string[];
  readonly contract: "valid" | "invalid" | "missing" | "cancelled";
}

// ── Handle record ───────────────────────────────────────────────────────────

export interface HandleRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly parentId?: string;
  readonly modelSet: string;

  readonly assignment: {
    readonly task: string;
    readonly requirements: readonly string[];
    readonly outputSchema: JsonSchema;
  };

  readonly producerSpec: ResolvedChildSpec;

  readonly criticSpec?: ResolvedChildSpec;

  // ── Managed subagent linkage ───────────────────────────────────────
  subagentId?: string;
  rootSubagentId?: string;

  // ── Producer cycles (repair reuses one Pi session) ──────────────────
  producerCycles: ProducerCycleRecord[];

  readonly createdAt: string;
  updatedAt: string;
  status: HandleStatus;
  value?: unknown;
  errors?: string[];

  verification?: VerificationSummary;
  review?: {
    readonly verdict: "approve" | "reject";
    readonly summary: string;
    readonly findings: readonly CriticFinding[];
    readonly missingRequirements: readonly string[];
  };

  /** Workflow binding set when the handle was spawned through a workflow transition. */
  workflowBinding?: WorkflowBinding;
}

// ── Workflow binding ────────────────────────────────────────────────────────

export interface WorkflowBinding {
  readonly instanceId: string;
  readonly actorId: string;

  readonly transitionExecutionId: string;

  readonly transitionId: WorkflowTransitionId;

  readonly sourceState: WorkflowStateId;

  readonly sourceRevision: number;

  readonly acceptedState: WorkflowStateId;

  readonly rejectedState: WorkflowStateId;
}

// ── Re-exports ──────────────────────────────────────────────────────────────

export type { AgentRole, ResolvedChildSpec };
