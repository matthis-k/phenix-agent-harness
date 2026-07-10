/**
 * handoff/schemas.ts — Runtime schemas and inferred types for all handoff kinds.
 *
 * Design: TypeBox runtime schemas with derived TypeScript types.
 * Every handoff submission is validated at the tool boundary.
 * Accepted artifacts are separate types constructed only by deterministic code.
 *
 * All schemas use literal discriminants for exhaustive matching.
 */

import { Type, type Static } from "typebox";

// ── Branded type helpers ──

export type ArtifactId = string & { readonly __brand: "ArtifactId" };
export type EffectId = string & { readonly __brand: "EffectId" };
export type ManifestDigest = string & { readonly __brand: "ManifestDigest" };

// ── Handoff identity (every submission must include these) ──

export const HandoffIdentitySchema = Type.Object({
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	stepId: Type.String({ minLength: 1 }),
	effectId: Type.String({ minLength: 1 }),
	attempt: Type.Integer({ minimum: 1 }),
});

export type HandoffIdentity = Static<typeof HandoffIdentitySchema>;

// ── Phase roles ──

export const PhaseRoleSchema = Type.Union([
	Type.Literal("scout"),
	Type.Literal("planner"),
	Type.Literal("worker"),
	Type.Literal("verifier"),
	Type.Literal("repair"),
]);

export type PhaseRole = Static<typeof PhaseRoleSchema>;

// ── Handoff kind discriminants ──

export const HandoffKindSchema = Type.Union([
	Type.Literal("scout-result"),
	Type.Literal("plan"),
	Type.Literal("worker-result"),
	Type.Literal("verification-report"),
	Type.Literal("repair-result"),
]);

export type HandoffKind = Static<typeof HandoffKindSchema>;

// ── Scout result ──

export const ScoutResultSchema = Type.Object({
	kind: Type.Literal("scout-result"),
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	stepId: Type.String({ minLength: 1 }),
	effectId: Type.String({ minLength: 1 }),
	attempt: Type.Integer({ minimum: 1 }),

	relevantFiles: Type.Array(Type.String()),
	editPoints: Type.Array(
		Type.Object({
			file: Type.String(),
			symbol: Type.Optional(Type.String()),
			reason: Type.String(),
		}),
	),
	constraints: Type.Array(Type.String()),
	risks: Type.Array(Type.String()),
	recommendation: Type.Union([
		Type.Literal("direct"),
		Type.Literal("planned"),
		Type.Literal("deep"),
	]),
});

export type ScoutResult = Static<typeof ScoutResultSchema>;

// ── Plan result ──

export const PlanResultSchema = Type.Object({
	kind: Type.Literal("plan"),
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	stepId: Type.String({ minLength: 1 }),
	effectId: Type.String({ minLength: 1 }),
	attempt: Type.Integer({ minimum: 1 }),

	objective: Type.String({ minLength: 1 }),
	steps: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			action: Type.String({ minLength: 1 }),
			files: Type.Optional(Type.Array(Type.String())),
			dependsOn: Type.Optional(Type.Array(Type.String())),
		}),
	),
	acceptanceCriteria: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			requirement: Type.String({ minLength: 1 }),
			check: Type.String({ minLength: 1 }),
		}),
	),
	nonGoals: Type.Array(Type.String()),
});

export type PlanResult = Static<typeof PlanResultSchema>;

// ── Worker result ──

export const WorkerResultSchema = Type.Object({
	kind: Type.Literal("worker-result"),
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	stepId: Type.String({ minLength: 1 }),
	effectId: Type.String({ minLength: 1 }),
	attempt: Type.Integer({ minimum: 1 }),

	summary: Type.String({ minLength: 1 }),
	completedPlanSteps: Type.Array(Type.String()),
	claimedChangedFiles: Type.Array(Type.String()),
	unresolvedIssues: Type.Array(Type.String()),
	verificationNotes: Type.Array(Type.String()),
});

export type WorkerResult = Static<typeof WorkerResultSchema>;

// ── Verification report ──

export const FileReviewStatusSchema = Type.Union([
	Type.Literal("accepted"),
	Type.Literal("rejected"),
]);

export const CriterionStatusSchema = Type.Union([
	Type.Literal("passed"),
	Type.Literal("failed"),
	Type.Literal("not-run"),
]);

export const VerificationReportSchema = Type.Object({
	kind: Type.Literal("verification-report"),
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	stepId: Type.String({ minLength: 1 }),
	effectId: Type.String({ minLength: 1 }),
	attempt: Type.Integer({ minimum: 1 }),

	subjectManifestDigest: Type.String({ minLength: 1 }),
	reviewedFiles: Type.Array(
		Type.Object({
			path: Type.String({ minLength: 1 }),
			status: FileReviewStatusSchema,
			findingIds: Type.Array(Type.String()),
		}),
	),
	criterionResults: Type.Array(
		Type.Object({
			criterionId: Type.String({ minLength: 1 }),
			status: CriterionStatusSchema,
			evidenceRefs: Type.Array(Type.String()),
		}),
	),
	findings: Type.Array(
		Type.Object({
			id: Type.String({ minLength: 1 }),
			severity: Type.Union([Type.Literal("blocking"), Type.Literal("warning")]),
			file: Type.Optional(Type.String()),
			summary: Type.String({ minLength: 1 }),
		}),
	),
	recommendation: Type.Union([Type.Literal("accept"), Type.Literal("repair")]),
});

export type VerificationReport = Static<typeof VerificationReportSchema>;

// ── Repair result ──

export const RepairResultSchema = Type.Object({
	kind: Type.Literal("repair-result"),
	schemaVersion: Type.Literal(1),
	runId: Type.String({ minLength: 1 }),
	stepId: Type.String({ minLength: 1 }),
	effectId: Type.String({ minLength: 1 }),
	attempt: Type.Integer({ minimum: 1 }),

	addressedFindingIds: Type.Array(Type.String()),
	summary: Type.String({ minLength: 1 }),
	claimedChangedFiles: Type.Array(Type.String()),
	remainingIssues: Type.Array(Type.String()),
});

export type RepairResult = Static<typeof RepairResultSchema>;

// ── Discriminated union of all handoff submissions ──

export const HandoffSubmissionSchema = Type.Union([
	ScoutResultSchema,
	PlanResultSchema,
	WorkerResultSchema,
	VerificationReportSchema,
	RepairResultSchema,
]);

export type HandoffSubmission = Static<typeof HandoffSubmissionSchema>;

// ── Accepted artifact types (constructed only by deterministic code) ──

export interface RepositoryChange {
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	path: string;
	oldPath?: string;
	contentDigest?: string;
}

export interface RepositoryManifest {
	baseHead: string;
	changes: RepositoryChange[];
	manifestDigest: string;
}

export interface ArtifactEnvelope<T> {
	artifactId: string;
	contract: string;
	schemaVersion: number;
	runId: string;
	stepId: string;
	effectId: string;
	attempt: number;
	createdAt: string;
	payloadDigest: string;
	payload: T;
}

export interface AcceptedArtifact {
	kind: "accepted-artifact";
	artifactId: ArtifactId;
	payloadDigest: string;
	submission: HandoffSubmission;
	repositoryManifest?: RepositoryManifest;
}

export interface VerifiedArtifact {
	kind: "verified-artifact";
	artifactId: ArtifactId;
	manifestDigest: string;
	verificationReportId: string;
	exactFileCoverage: true;
	allRequiredCriteriaPassed: true;
}

// ── Map role to expected handoff kind ──

export const ROLE_TO_HANDOFF_KIND: Record<PhaseRole, HandoffKind> = {
	scout: "scout-result",
	planner: "plan",
	worker: "worker-result",
	verifier: "verification-report",
	repair: "repair-result",
};

export const HANDOFF_KIND_TO_ROLE: Record<HandoffKind, PhaseRole> = {
	"scout-result": "scout",
	plan: "planner",
	"worker-result": "worker",
	"verification-report": "verifier",
	"repair-result": "repair",
};

// ── Runtime validation helpers ──

/** Helper: check a value is a string */
function isString(v: unknown): v is string {
	return typeof v === "string";
}

/** Helper: check a value is a number */
function isNumber(v: unknown): v is number {
	return typeof v === "number" && !Number.isNaN(v);
}

/** Helper: check a value is a record (object, not array, not null) */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Helper: check a value is an array */
function isArray(v: unknown): v is unknown[] {
	return Array.isArray(v);
}

/** Helper: check a value is a string array */
function isStringArray(v: unknown): v is string[] {
	return isArray(v) && v.every((x) => isString(x));
}

/**
 * Validate untrusted data and extract its discriminant kind.
 * Returns the kind if valid, or error messages.
 */
export function validateKind(
	data: unknown,
): { ok: true; kind: HandoffKind } | { ok: false; errors: string[] } {
	if (!isRecord(data)) {
		return { ok: false, errors: ["submission must be a JSON object"] };
	}
	const kind = data.kind;
	if (!isString(kind)) {
		return { ok: false, errors: ["kind must be a string"] };
	}
	const kinds: HandoffKind[] = [
		"scout-result",
		"plan",
		"worker-result",
		"verification-report",
		"repair-result",
	];
	if (!(kinds as string[]).includes(kind)) {
		return {
			ok: false,
			errors: [`unknown handoff kind "${kind}"`],
		};
	}
	return { ok: true, kind: kind as HandoffKind };
}

/**
 * Validate common identity fields for a submission.
 */
export function validateIdentity(
	data: unknown,
): { ok: true; identity: HandoffIdentity } | { ok: false; errors: string[] } {
	if (!isRecord(data)) {
		return { ok: false, errors: ["submission must be a JSON object"] };
	}

	const errors: string[] = [];

	if (data.schemaVersion !== 1) {
		errors.push(`schemaVersion must be 1, got ${String(data.schemaVersion)}`);
	}
	if (!isString(data.runId) || data.runId.length === 0) {
		errors.push("runId must be a non-empty string");
	}
	if (!isString(data.stepId) || data.stepId.length === 0) {
		errors.push("stepId must be a non-empty string");
	}
	if (!isString(data.effectId) || data.effectId.length === 0) {
		errors.push("effectId must be a non-empty string");
	}
	if (
		!isNumber(data.attempt) ||
		data.attempt < 1 ||
		!Number.isInteger(data.attempt)
	) {
		errors.push("attempt must be a positive integer");
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		identity: {
			schemaVersion: 1,
			runId: data.runId as string,
			stepId: data.stepId as string,
			effectId: data.effectId as string,
			attempt: data.attempt as number,
		},
	};
}

/**
 * Validate a scout-result submission payload (after identity/kind checks).
 */
export function validateScoutPayload(
	data: Record<string, unknown>,
): { ok: true; value: ScoutResult } | { ok: false; errors: string[] } {
	const errors: string[] = [];

	if (!isStringArray(data.relevantFiles)) {
		errors.push("relevantFiles must be an array of strings");
	}
	if (!isArray(data.editPoints)) {
		errors.push("editPoints must be an array");
	} else {
		for (let i = 0; i < data.editPoints.length; i++) {
			const ep = data.editPoints[i];
			if (!isRecord(ep)) {
				errors.push(`editPoints[${i}] must be an object`);
			} else {
				if (!isString(ep.file))
					errors.push(`editPoints[${i}].file must be a string`);
				if (ep.symbol !== undefined && !isString(ep.symbol))
					errors.push(`editPoints[${i}].symbol must be a string`);
				if (!isString(ep.reason))
					errors.push(`editPoints[${i}].reason must be a string`);
			}
		}
	}
	if (!isStringArray(data.constraints)) {
		errors.push("constraints must be an array of strings");
	}
	if (!isStringArray(data.risks)) {
		errors.push("risks must be an array of strings");
	}
	const validRecs = ["direct", "planned", "deep"];
	if (!validRecs.includes(data.recommendation as string)) {
		errors.push("recommendation must be 'direct', 'planned', or 'deep'");
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: data as unknown as ScoutResult };
}

/**
 * Validate a plan submission payload.
 */
export function validatePlanPayload(
	data: Record<string, unknown>,
): { ok: true; value: PlanResult } | { ok: false; errors: string[] } {
	const errors: string[] = [];

	if (!isString(data.objective) || data.objective.length === 0) {
		errors.push("objective must be a non-empty string");
	}
	if (!isArray(data.steps) || data.steps.length === 0) {
		errors.push("steps must be a non-empty array");
	} else {
		for (let i = 0; i < data.steps.length; i++) {
			const s = data.steps[i];
			if (!isRecord(s)) {
				errors.push(`steps[${i}] must be an object`);
			} else {
				if (!isString(s.id)) errors.push(`steps[${i}].id must be a string`);
				if (!isString(s.action))
					errors.push(`steps[${i}].action must be a string`);
				if (s.files !== undefined && !isStringArray(s.files))
					errors.push(`steps[${i}].files must be an array of strings`);
				if (s.dependsOn !== undefined && !isStringArray(s.dependsOn))
					errors.push(`steps[${i}].dependsOn must be an array of strings`);
			}
		}
	}
	if (!isArray(data.acceptanceCriteria)) {
		errors.push("acceptanceCriteria must be an array");
	} else {
		for (let i = 0; i < data.acceptanceCriteria.length; i++) {
			const ac = data.acceptanceCriteria[i];
			if (!isRecord(ac)) {
				errors.push(`acceptanceCriteria[${i}] must be an object`);
			} else {
				if (!isString(ac.id))
					errors.push(`acceptanceCriteria[${i}].id must be a string`);
				if (!isString(ac.requirement))
					errors.push(`acceptanceCriteria[${i}].requirement must be a string`);
				if (!isString(ac.check))
					errors.push(`acceptanceCriteria[${i}].check must be a string`);
			}
		}
	}
	if (!isStringArray(data.nonGoals)) {
		errors.push("nonGoals must be an array of strings");
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: data as unknown as PlanResult };
}

/**
 * Validate a worker-result submission payload.
 */
export function validateWorkerPayload(
	data: Record<string, unknown>,
): { ok: true; value: WorkerResult } | { ok: false; errors: string[] } {
	const errors: string[] = [];

	if (!isString(data.summary) || data.summary.length === 0) {
		errors.push("summary must be a non-empty string");
	}
	if (!isStringArray(data.completedPlanSteps)) {
		errors.push("completedPlanSteps must be an array of strings");
	}
	if (!isStringArray(data.claimedChangedFiles)) {
		errors.push("claimedChangedFiles must be an array of strings");
	}
	if (!isStringArray(data.unresolvedIssues)) {
		errors.push("unresolvedIssues must be an array of strings");
	}
	if (!isStringArray(data.verificationNotes)) {
		errors.push("verificationNotes must be an array of strings");
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: data as unknown as WorkerResult };
}

/**
 * Validate a verification-report submission payload.
 */
export function validateVerificationPayload(
	data: Record<string, unknown>,
): { ok: true; value: VerificationReport } | { ok: false; errors: string[] } {
	const errors: string[] = [];

	if (!isString(data.subjectManifestDigest)) {
		errors.push("subjectManifestDigest must be a string");
	}
	if (!isArray(data.reviewedFiles)) {
		errors.push("reviewedFiles must be an array");
	} else {
		for (let i = 0; i < data.reviewedFiles.length; i++) {
			const rf = data.reviewedFiles[i];
			if (!isRecord(rf)) {
				errors.push(`reviewedFiles[${i}] must be an object`);
			} else {
				if (!isString(rf.path))
					errors.push(`reviewedFiles[${i}].path must be a string`);
				if (!["accepted", "rejected"].includes(rf.status as string))
					errors.push(
						`reviewedFiles[${i}].status must be "accepted" or "rejected"`,
					);
				if (!isStringArray(rf.findingIds))
					errors.push(
						`reviewedFiles[${i}].findingIds must be an array of strings`,
					);
			}
		}
	}
	if (!isArray(data.criterionResults)) {
		errors.push("criterionResults must be an array");
	} else {
		for (let i = 0; i < data.criterionResults.length; i++) {
			const cr = data.criterionResults[i];
			if (!isRecord(cr)) {
				errors.push(`criterionResults[${i}] must be an object`);
			} else {
				if (!isString(cr.criterionId))
					errors.push(`criterionResults[${i}].criterionId must be a string`);
				if (!["passed", "failed", "not-run"].includes(cr.status as string))
					errors.push(
						`criterionResults[${i}].status must be "passed", "failed", or "not-run"`,
					);
				if (!isStringArray(cr.evidenceRefs))
					errors.push(
						`criterionResults[${i}].evidenceRefs must be an array of strings`,
					);
			}
		}
	}
	if (!isArray(data.findings)) {
		errors.push("findings must be an array");
	} else {
		for (let i = 0; i < data.findings.length; i++) {
			const f = data.findings[i];
			if (!isRecord(f)) {
				errors.push(`findings[${i}] must be an object`);
			} else {
				if (!isString(f.id)) errors.push(`findings[${i}].id must be a string`);
				if (!["blocking", "warning"].includes(f.severity as string))
					errors.push(
						`findings[${i}].severity must be "blocking" or "warning"`,
					);
				if (f.file !== undefined && !isString(f.file))
					errors.push(`findings[${i}].file must be a string`);
				if (!isString(f.summary))
					errors.push(`findings[${i}].summary must be a string`);
			}
		}
	}
	if (!["accept", "repair"].includes(data.recommendation as string)) {
		errors.push('recommendation must be "accept" or "repair"');
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: data as unknown as VerificationReport };
}

/**
 * Validate a repair-result submission payload.
 */
export function validateRepairPayload(
	data: Record<string, unknown>,
): { ok: true; value: RepairResult } | { ok: false; errors: string[] } {
	const errors: string[] = [];

	if (!isStringArray(data.addressedFindingIds)) {
		errors.push("addressedFindingIds must be an array of strings");
	}
	if (!isString(data.summary) || data.summary.length === 0) {
		errors.push("summary must be a non-empty string");
	}
	if (!isStringArray(data.claimedChangedFiles)) {
		errors.push("claimedChangedFiles must be an array of strings");
	}
	if (!isStringArray(data.remainingIssues)) {
		errors.push("remainingIssues must be an array of strings");
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, value: data as unknown as RepairResult };
}

/**
 * Check that unknown keys are not present in the data.
 * Accepts any top-level keys defined in the union schema.
 */
const KNOWN_KINDS = new Set([
	"scout-result",
	"plan",
	"worker-result",
	"verification-report",
	"repair-result",
]);

const COMMON_KEYS = new Set([
	"kind",
	"schemaVersion",
	"runId",
	"stepId",
	"effectId",
	"attempt",
]);

const SCOUT_KEYS = new Set([
	...COMMON_KEYS,
	"relevantFiles",
	"editPoints",
	"constraints",
	"risks",
	"recommendation",
]);

const PLAN_KEYS = new Set([
	...COMMON_KEYS,
	"objective",
	"steps",
	"acceptanceCriteria",
	"nonGoals",
]);

const WORKER_KEYS = new Set([
	...COMMON_KEYS,
	"summary",
	"completedPlanSteps",
	"claimedChangedFiles",
	"unresolvedIssues",
	"verificationNotes",
]);

const VERIFIER_KEYS = new Set([
	...COMMON_KEYS,
	"subjectManifestDigest",
	"reviewedFiles",
	"criterionResults",
	"findings",
	"recommendation",
]);

const REPAIR_KEYS = new Set([
	...COMMON_KEYS,
	"addressedFindingIds",
	"summary",
	"claimedChangedFiles",
	"remainingIssues",
]);

const ALLOWED_KEYS_BY_KIND: Record<string, Set<string>> = {
	"scout-result": SCOUT_KEYS,
	plan: PLAN_KEYS,
	"worker-result": WORKER_KEYS,
	"verification-report": VERIFIER_KEYS,
	"repair-result": REPAIR_KEYS,
};

/**
 * Check for unknown top-level keys in a submission.
 * Returns a list of unknown key names, or an empty list.
 */
export function findUnknownKeys(data: Record<string, unknown>): string[] {
	const kind = data.kind;
	if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) {
		return Object.keys(data).filter((k) => !COMMON_KEYS.has(k));
	}

	const allowed = ALLOWED_KEYS_BY_KIND[kind] ?? COMMON_KEYS;
	const unknown: string[] = [];
	for (const key of Object.keys(data)) {
		if (!allowed.has(key)) {
			unknown.push(key);
		}
	}
	return unknown;
}
