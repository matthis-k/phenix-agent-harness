import type {
  ChildRunId,
  ChildSessionBackendKind,
  SerializedError,
} from "../phenix-runtime/child-session-types.ts";
import type { WorkflowStateId, WorkflowTransitionId } from "../phenix-workflow/workflow-types.ts";
import type { AgentRole } from "./agent-types.ts";
import type { ResolvedChildSpec } from "./child-spec.ts";
import type { JsonSchema } from "./contracts.ts";

// ── Constants (used by index.ts; extracted for visibility) ──────────────────

export const HANDLE_VERSION = 4;

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

  // Child session summaries (for multi-session cycles)
  childSessions?: readonly ChildSessionSummary[];
}

export interface ChildSessionSummary {
  readonly role: string;
  readonly status: "completed" | "failed";
  readonly sessionFile?: string;
  readonly transcriptPath?: string;
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

// ── Handle record (version 2) ───────────────────────────────────────────────

export interface HandleRecord {
  readonly version: typeof HANDLE_VERSION;

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

  // ── Child session linkage (distinct from Pi session IDs) ────────────
  childRunId?: ChildRunId;
  rootChildRunId?: ChildRunId;
  backend?: ChildSessionBackendKind;
  piSessionId?: string;
  piSessionFile?: string;

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

  /** Workflow binding set when the handle was spawned through a v4 workflow transition. */
  workflowBinding?: WorkflowBinding;
}

// ── Workflow binding (v4) ───────────────────────────────────────────────────

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

// ── Extended handle record with workflow binding ────────────────────────────

export interface HandleRecordWithWorkflow extends HandleRecord {
  readonly workflowBinding: WorkflowBinding;
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

// ── Re-exports ──────────────────────────────────────────────────────────────

export type { AgentRole, ResolvedChildSpec };
