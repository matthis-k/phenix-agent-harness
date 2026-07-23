import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";

export interface ObjectiveRequest {
  readonly objective: string;
  readonly context?: unknown;
}

export interface ScoutRequest extends ObjectiveRequest {
  readonly focus?: string;
}

export interface EvidenceItem {
  readonly path: string;
  readonly line?: number;
  readonly finding: string;
}

export interface ScoutReport {
  readonly summary: string;
  readonly evidence: readonly EvidenceItem[];
  readonly risks: readonly string[];
}

export interface PlanRequest extends ObjectiveRequest {
  readonly evidence?: unknown;
}

export interface PlanResult {
  readonly summary: string;
  readonly steps: readonly string[];
  readonly constraints: readonly string[];
  readonly checks: readonly string[];
}

export interface ImplementationRequest extends ObjectiveRequest {
  readonly plan?: PlanResult;
  readonly previousChangeSet?: ChangeSet;
  readonly findings?: readonly string[];
}

export interface CheckResult {
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
}

export interface TestRequest extends ObjectiveRequest {
  readonly checks: readonly CheckResult[];
}

export interface TestReport {
  readonly summary: string;
  readonly checks: readonly CheckResult[];
  readonly findings: readonly string[];
  readonly evidence: readonly string[];
}

export interface ChangeSet {
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly checks: readonly CheckResult[];
  readonly unresolved: readonly string[];
}

export interface VerificationRequest extends ObjectiveRequest {
  readonly changeSet: ChangeSet;
}

export interface VerificationResult {
  readonly accepted: boolean;
  readonly summary: string;
  readonly findings: readonly string[];
  readonly evidence: readonly string[];
}

export interface CriticRequest extends ObjectiveRequest {
  readonly artifact?: unknown;
  readonly focus?: string;
}

export interface CriticReport {
  readonly summary: string;
  readonly findings: readonly {
    readonly severity: "low" | "medium" | "high";
    readonly title: string;
    readonly evidence: string;
  }[];
}

export interface BaseResult {
  readonly summary: string;
  readonly artifacts: readonly unknown[];
  readonly unresolved: readonly string[];
}

export interface QAReport {
  readonly summary: string;
  readonly findings: readonly {
    readonly severity: "low" | "medium" | "high";
    readonly title: string;
    readonly evidence: string;
    readonly recommendation: string;
  }[];
  readonly reports: readonly unknown[];
}

export interface ImplementationResult {
  readonly summary: string;
  readonly changeSet: ChangeSet;
  readonly verification: VerificationResult;
  readonly attempts: number;
}

export interface FinalReport {
  readonly summary: string;
  readonly changed: boolean;
  readonly qa: QAReport;
  readonly implementation?: ImplementationResult;
  readonly verification?: VerificationResult;
}

const objective = {
  objective: Type.String({ minLength: 1 }),
  context: Type.Optional(Type.Unknown()),
};
const evidenceItem = Type.Object({
  path: Type.String(),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  finding: Type.String(),
});
const checkResult = Type.Object({
  command: Type.String(),
  ok: Type.Boolean(),
  summary: Type.String(),
});
export const ChangeSetType = Type.Object({
  summary: Type.String(),
  changedFiles: Type.Array(Type.String()),
  checks: Type.Array(checkResult),
  unresolved: Type.Array(Type.String()),
});
export const VerificationResultType = Type.Object({
  accepted: Type.Boolean(),
  summary: Type.String(),
  findings: Type.Array(Type.String()),
  evidence: Type.Array(Type.String()),
});
const qaFinding = Type.Object({
  severity: Type.Enum(["low", "medium", "high"]),
  title: Type.String(),
  evidence: Type.String(),
  recommendation: Type.String(),
});
export const QAReportType = Type.Object({
  summary: Type.String(),
  findings: Type.Array(qaFinding),
  reports: Type.Array(Type.Unknown()),
});
export const ImplementationResultType = Type.Object({
  summary: Type.String(),
  changeSet: ChangeSetType,
  verification: VerificationResultType,
  attempts: Type.Integer({ minimum: 1 }),
});

export const ObjectiveRequestSchema = defineSchema<ObjectiveRequest>(
  "request.objective.v1",
  Type.Object(objective),
);
export const ScoutRequestSchema = defineSchema<ScoutRequest>(
  "request.scout.v1",
  Type.Object({ ...objective, focus: Type.Optional(Type.String()) }),
);
export const ScoutReportSchema = defineSchema<ScoutReport>(
  "outcome.scout-report.v1",
  Type.Object({
    summary: Type.String(),
    evidence: Type.Array(evidenceItem),
    risks: Type.Array(Type.String()),
  }),
);
export const PlanRequestSchema = defineSchema<PlanRequest>(
  "request.plan.v1",
  Type.Object({ ...objective, evidence: Type.Optional(Type.Unknown()) }),
);
export const PlanResultSchema = defineSchema<PlanResult>(
  "outcome.plan.v1",
  Type.Object({
    summary: Type.String(),
    steps: Type.Array(Type.String()),
    constraints: Type.Array(Type.String()),
    checks: Type.Array(Type.String()),
  }),
);
export const ImplementationRequestSchema = defineSchema<ImplementationRequest>(
  "request.implementation.v1",
  Type.Object({
    ...objective,
    plan: Type.Optional(
      Type.Object({
        summary: Type.String(),
        steps: Type.Array(Type.String()),
        constraints: Type.Array(Type.String()),
        checks: Type.Array(Type.String()),
      }),
    ),
    previousChangeSet: Type.Optional(ChangeSetType),
    findings: Type.Optional(Type.Array(Type.String())),
  }),
);
export const TestRequestSchema = defineSchema<TestRequest>(
  "request.test.v1",
  Type.Object({ ...objective, checks: Type.Array(checkResult) }),
);
export const TestReportSchema = defineSchema<TestReport>(
  "outcome.test-report.v1",
  Type.Object({
    summary: Type.String(),
    checks: Type.Array(checkResult),
    findings: Type.Array(Type.String()),
    evidence: Type.Array(Type.String()),
  }),
);
export const ChangeSetSchema = defineSchema<ChangeSet>("outcome.change-set.v1", ChangeSetType);
export const VerificationRequestSchema = defineSchema<VerificationRequest>(
  "request.verification.v1",
  Type.Object({ ...objective, changeSet: ChangeSetType }),
);
export const VerificationResultSchema = defineSchema<VerificationResult>(
  "outcome.verification.v1",
  VerificationResultType,
);
export const CriticRequestSchema = defineSchema<CriticRequest>(
  "request.critic.v1",
  Type.Object({
    ...objective,
    artifact: Type.Optional(Type.Unknown()),
    focus: Type.Optional(Type.String()),
  }),
);
export const CriticReportSchema = defineSchema<CriticReport>(
  "outcome.critic-report.v1",
  Type.Object({
    summary: Type.String(),
    findings: Type.Array(
      Type.Object({
        severity: Type.Enum(["low", "medium", "high"]),
        title: Type.String(),
        evidence: Type.String(),
      }),
    ),
  }),
);
export const BaseResultSchema = defineSchema<BaseResult>(
  "outcome.base.v1",
  Type.Object({
    summary: Type.String(),
    artifacts: Type.Array(Type.Unknown()),
    unresolved: Type.Array(Type.String()),
  }),
);
export const QASynthesisRequestSchema = defineSchema<{
  readonly objective: string;
  readonly reports: readonly unknown[];
}>(
  "request.qa-synthesis.v1",
  Type.Object({ objective: Type.String(), reports: Type.Array(Type.Unknown()) }),
);
export const QAReportSchema = defineSchema<QAReport>("outcome.qa-report.v1", QAReportType);
export const ImplementationResultSchema = defineSchema<ImplementationResult>(
  "outcome.implementation-result.v1",
  ImplementationResultType,
);
export const FinalReportSchema = defineSchema<FinalReport>(
  "outcome.final-report.v1",
  Type.Object({
    summary: Type.String(),
    changed: Type.Boolean(),
    qa: QAReportType,
    implementation: Type.Optional(ImplementationResultType),
    verification: Type.Optional(VerificationResultType),
  }),
);
