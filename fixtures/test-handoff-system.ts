/**
 * test-handoff-system.ts — Comprehensive tests for the typed handoff system.
 *
 * Tests cover:
 *   - Runtime schemas
 *   - Correlation validation
 *   - Artifact store
 *   - Repository manifest
 *   - Verification validator
 *   - Workflow integration
 *
 * Run with:
 *   npx tsx fixtures/test-handoff-system.ts
 */

// ═══════════════════════════════════════════════
// Test framework
// ═══════════════════════════════════════════════

interface TestResult {
	name: string;
	passed: boolean;
	detail: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail: string): void {
	results.push({ name, passed: condition, detail });
	if (!condition) {
		console.error(`  ✗ FAIL: ${name}`);
		console.error(`    ${detail}`);
	} else {
		console.log(`  ✓ PASS: ${name}`);
	}
}

function describe(suite: string, fn: () => void): void {
	console.log(`\n== ${suite} ==`);
	fn();
}

// ═══════════════════════════════════════════════
// 1. Runtime schema tests
// ═══════════════════════════════════════════════

import {
	validateKind,
	validateIdentity,
	validateScoutPayload,
	validatePlanPayload,
	validateWorkerPayload,
	validateVerificationPayload,
	validateRepairPayload,
	findUnknownKeys,
	HANDOFF_KIND_TO_ROLE,
	ROLE_TO_HANDOFF_KIND,
} from "../config/phenix-pi/pi/extensions/phenix-flow/handoff/schemas";

describe("Runtime schemas", () => {
	// Valid scout result
	const validScout = () => ({
		kind: "scout-result",
		schemaVersion: 1,
		runId: "run-1",
		stepId: "scout-repo",
		effectId: "run-1:0:Context:0",
		attempt: 1,
		relevantFiles: ["src/index.ts"],
		editPoints: [{ file: "src/index.ts", reason: "Need to add exports" }],
		constraints: ["Must not break API"],
		risks: ["Large refactor"],
		recommendation: "planned",
	});

	assert(
		"valid scout result passes kind+identity checks",
		validateKind(validScout()).ok && validateIdentity(validScout()).ok,
		"scout result should validate",
	);

	assert(
		"valid scout result passes payload validation",
		validateScoutPayload(validScout()).ok,
		"scout payload should validate",
	);

	// Unknown kind
	assert(
		"unknown handoff kind is rejected",
		!validateKind({ kind: "unknown-kind" }).ok,
		"unknown kind should fail",
	);

	// Missing kind
	assert(
		"missing kind is rejected",
		!validateKind({ schemaVersion: 1 }).ok,
		"missing kind should fail",
	);

	// Wrong schema version
	assert(
		"wrong schema version is rejected",
		!validateIdentity({
			...validScout(),
			schemaVersion: 2,
		}).ok,
		"schemaVersion 2 should fail",
	);

	// Empty identifiers
	assert(
		"empty runId is rejected",
		!validateIdentity({
			schemaVersion: 1,
			runId: "",
			stepId: "s1",
			effectId: "e1",
			attempt: 1,
		}).ok,
		"empty runId should fail",
	);

	// Invalid attempt
	assert(
		"attempt 0 is rejected",
		!validateIdentity({
			schemaVersion: 1,
			runId: "r1",
			stepId: "s1",
			effectId: "e1",
			attempt: 0,
		}).ok,
		"attempt 0 should fail",
	);

	// Negative attempt
	assert(
		"negative attempt is rejected",
		!validateIdentity({
			schemaVersion: 1,
			runId: "r1",
			stepId: "s1",
			effectId: "e1",
			attempt: -1,
		}).ok,
		"negative attempt should fail",
	);

	// Valid plan
	const validPlan = () => ({
		kind: "plan",
		schemaVersion: 1,
		runId: "run-1",
		stepId: "plan-work",
		effectId: "run-1:1:Planning:0",
		attempt: 1,
		objective: "Implement handoff system",
		steps: [
			{ id: "step-1", action: "Create schemas", files: ["src/schemas.ts"] },
			{ id: "step-2", action: "Create tool", dependsOn: ["step-1"] },
		],
		acceptanceCriteria: [
			{ id: "crit-1", requirement: "Schemas validate", check: "Run tests" },
		],
		nonGoals: ["No UI changes"],
	});

	assert(
		"valid plan passes validation",
		validatePlanPayload(validPlan()).ok,
		"plan should validate",
	);

	// Plan with no objective
	assert(
		"plan with empty objective is rejected",
		!validatePlanPayload({
			...validPlan(),
			objective: "",
		}).ok,
		"empty objective should fail",
	);

	// Plan with empty steps
	assert(
		"plan with no steps is rejected",
		!validatePlanPayload({
			...validPlan(),
			steps: [],
		}).ok,
		"empty steps should fail",
	);

	// Valid worker result
	const validWorker = () => ({
		kind: "worker-result",
		schemaVersion: 1,
		runId: "run-1",
		stepId: "implement",
		effectId: "run-1:2:Implementation:0",
		attempt: 1,
		summary: "Implemented the feature",
		completedPlanSteps: ["step-1"],
		claimedChangedFiles: ["src/schemas.ts"],
		unresolvedIssues: [],
		verificationNotes: ["All tests pass"],
	});

	assert(
		"valid worker result passes validation",
		validateWorkerPayload(validWorker()).ok,
		"worker should validate",
	);

	// Worker with unresolved issues as array
	assert(
		"worker with valid unresolvedIssues passes",
		validateWorkerPayload({
			...validWorker(),
			unresolvedIssues: ["Edge case not handled"],
		}).ok,
		"worker with issues should validate",
	);

	// Valid verification report
	const validVerification = () => ({
		kind: "verification-report",
		schemaVersion: 1,
		runId: "run-1",
		stepId: "verify",
		effectId: "run-1:3:Verification:0",
		attempt: 1,
		subjectManifestDigest: "abc123",
		reviewedFiles: [
			{ path: "src/schemas.ts", status: "accepted", findingIds: [] },
		],
		criterionResults: [
			{
				criterionId: "crit-1",
				status: "passed",
				evidenceRefs: ["test-output"],
			},
		],
		findings: [],
		recommendation: "accept",
	});

	assert(
		"valid verification report passes validation",
		validateVerificationPayload(validVerification()).ok,
		"verification should validate",
	);

	assert(
		"verification with blocking finding passes schema validation",
		validateVerificationPayload({
			...validVerification(),
			findings: [
				{ id: "f-1", severity: "blocking", summary: "Something wrong" },
			],
		}).ok,
		"verification with findings should validate structurally",
	);

	// Valid repair result
	const validRepair = () => ({
		kind: "repair-result",
		schemaVersion: 1,
		runId: "run-1",
		stepId: "repair",
		effectId: "run-1:2:Implementation:1",
		attempt: 2,
		addressedFindingIds: ["f-1"],
		summary: "Fixed the issue",
		claimedChangedFiles: ["src/schemas.ts"],
		remainingIssues: [],
	});

	assert(
		"valid repair result passes validation",
		validateRepairPayload(validRepair()).ok,
		"repair should validate",
	);

	// Unknown keys
	assert(
		"unknown keys are detected",
		findUnknownKeys({ kind: "plan", extraField: true } as any).includes(
			"extraField",
		),
		"extraField should be detected as unknown",
	);

	// All known keys pass
	assert(
		"plan has no unknown keys",
		findUnknownKeys(validPlan() as any).length === 0,
		"all plan keys should be known",
	);

	// Role mapping
	assert(
		"HANDOFF_KIND_TO_ROLE maps correctly",
		HANDOFF_KIND_TO_ROLE["scout-result"] === "scout" &&
			HANDOFF_KIND_TO_ROLE["plan"] === "planner" &&
			HANDOFF_KIND_TO_ROLE["worker-result"] === "worker" &&
			HANDOFF_KIND_TO_ROLE["verification-report"] === "verifier" &&
			HANDOFF_KIND_TO_ROLE["repair-result"] === "repair",
		"all handoff kinds should map to correct roles",
	);

	assert(
		"ROLE_TO_HANDOFF_KIND maps correctly",
		ROLE_TO_HANDOFF_KIND["scout"] === "scout-result" &&
			ROLE_TO_HANDOFF_KIND["planner"] === "plan" &&
			ROLE_TO_HANDOFF_KIND["worker"] === "worker-result" &&
			ROLE_TO_HANDOFF_KIND["verifier"] === "verification-report" &&
			ROLE_TO_HANDOFF_KIND["repair"] === "repair-result",
		"all roles should map to correct handoff kinds",
	);
});

// ═══════════════════════════════════════════════
// 2. Artifact store tests (without filesystem)
// ═══════════════════════════════════════════════

import {
	digestJson,
	sha256,
	generateArtifactId,
} from "../config/phenix-pi/pi/extensions/phenix-flow/handoff/artifact-store";

describe("Artifact store (pure functions)", () => {
	assert(
		"SHA-256 produces consistent output",
		sha256("hello") === sha256("hello"),
		"same input should produce same hash",
	);

	assert(
		"different content produces different SHA-256",
		sha256("hello") !== sha256("world"),
		"different input should produce different hash",
	);

	assert(
		"SHA-256 is 64 hex chars",
		sha256("test").length === 64,
		"SHA-256 hex should be 64 characters",
	);

	assert(
		"canonical JSON sorts keys",
		digestJson({ b: 1, a: 2 }) === digestJson({ a: 2, b: 1 }),
		"canonical JSON should be key-order independent",
	);

	assert(
		"artifact ID is unique",
		generateArtifactId() !== generateArtifactId(),
		"sequential calls should produce different IDs",
	);
});

// ═══════════════════════════════════════════════
// 3. Verification validator tests
// ═══════════════════════════════════════════════

import {
	evaluateVerification,
	createVerifiedArtifact,
} from "../config/phenix-pi/pi/extensions/phenix-flow/handoff/verification-validator";
import type {
	RepositoryManifest,
	VerificationReport,
} from "../config/phenix-pi/pi/extensions/phenix-flow/handoff/schemas";

describe("Verification validator", () => {
	const makeManifest = (
		overrides: Partial<RepositoryManifest> = {},
	): RepositoryManifest => ({
		baseHead: "abc123def456",
		changes: [
			{ status: "modified", path: "src/index.ts", contentDigest: "digest1" },
			{ status: "added", path: "src/new.ts", contentDigest: "digest2" },
		],
		manifestDigest: "manifest-digest-1",
		...overrides,
	});

	const makeReport = (
		overrides: Partial<VerificationReport> = {},
	): VerificationReport => ({
		kind: "verification-report",
		schemaVersion: 1,
		runId: "run-1",
		stepId: "verify",
		effectId: "run-1:3:Verification:0",
		attempt: 1,
		subjectManifestDigest: "manifest-digest-1",
		reviewedFiles: [
			{ path: "src/index.ts", status: "accepted", findingIds: [] },
			{ path: "src/new.ts", status: "accepted", findingIds: [] },
		],
		criterionResults: [
			{ criterionId: "crit-1", status: "passed", evidenceRefs: ["test"] },
			{ criterionId: "crit-2", status: "passed", evidenceRefs: ["lint"] },
		],
		findings: [],
		recommendation: "accept",
		...overrides,
	});

	const requiredCriteria = ["crit-1", "crit-2"];

	assert(
		"exact valid file coverage passes",
		evaluateVerification(makeReport(), makeManifest(), requiredCriteria)
			.accepted,
		"all files reviewed and criteria passed",
	);

	// One missing file
	const missingFileResult = evaluateVerification(
		makeReport({
			reviewedFiles: [
				{ path: "src/index.ts", status: "accepted", findingIds: [] },
				// src/new.ts is missing
			],
		}),
		makeManifest(),
		requiredCriteria,
	);
	assert(
		"one missing file causes rejection",
		!missingFileResult.accepted &&
			missingFileResult.reasons.some((r) => r.includes("Missing file reviews")),
		"missing file should be detected",
	);

	// Omitted deletion (manifest has no deletions in this case — check differently)
	const manifestWithDeletion = makeManifest({
		changes: [
			{ status: "modified", path: "src/index.ts", contentDigest: "digest1" },
			{ status: "deleted", path: "src/old.ts" },
		],
	});
	const missingDeletionResult = evaluateVerification(
		makeReport({
			subjectManifestDigest: manifestWithDeletion.manifestDigest,
			reviewedFiles: [
				{ path: "src/index.ts", status: "accepted", findingIds: [] },
				// src/old.ts deletion not reviewed
			],
		}),
		manifestWithDeletion,
		requiredCriteria,
	);
	assert(
		"omitted deletion is detected",
		!missingDeletionResult.accepted &&
			missingDeletionResult.reasons.some((r) =>
				r.includes("Missing file reviews"),
			),
		"deletion should be reviewed",
	);

	// Stale manifest digest
	assert(
		"stale manifest digest is rejected",
		!evaluateVerification(
			makeReport({ subjectManifestDigest: "stale-digest" }),
			makeManifest(),
			requiredCriteria,
		).accepted,
		"stale digest should fail",
	);

	// Missing criterion
	const missingCriterionResult = evaluateVerification(
		makeReport({
			criterionResults: [
				{ criterionId: "crit-1", status: "passed", evidenceRefs: ["test"] },
				// crit-2 is missing
			],
		}),
		makeManifest(),
		requiredCriteria,
	);
	assert(
		"missing criterion is detected",
		!missingCriterionResult.accepted &&
			missingCriterionResult.reasons.some((r) =>
				r.includes("Missing criteria"),
			),
		"missing criterion should fail",
	);

	// Failed criterion
	const failedCriterionResult = evaluateVerification(
		makeReport({
			criterionResults: [
				{ criterionId: "crit-1", status: "passed", evidenceRefs: ["test"] },
				{ criterionId: "crit-2", status: "failed", evidenceRefs: [] },
			],
		}),
		makeManifest(),
		requiredCriteria,
	);
	assert(
		"failed criterion is detected",
		!failedCriterionResult.accepted &&
			failedCriterionResult.reasons.some((r) => r.includes("Failed criteria")),
		"failed criterion should fail",
	);

	// Not-run criterion
	const notRunResult = evaluateVerification(
		makeReport({
			criterionResults: [
				{ criterionId: "crit-1", status: "passed", evidenceRefs: ["test"] },
				{ criterionId: "crit-2", status: "not-run", evidenceRefs: [] },
			],
		}),
		makeManifest(),
		requiredCriteria,
	);
	assert(
		"not-run criterion is detected",
		!notRunResult.accepted &&
			notRunResult.reasons.some((r) => r.includes("Not-run")),
		"not-run criterion should fail",
	);

	// Duplicate conflicting reviews
	const conflictResult = evaluateVerification(
		makeReport({
			reviewedFiles: [
				{ path: "src/index.ts", status: "accepted", findingIds: [] },
				{ path: "src/index.ts", status: "rejected", findingIds: ["f-1"] },
				{ path: "src/new.ts", status: "accepted", findingIds: [] },
			],
		}),
		makeManifest(),
		requiredCriteria,
	);
	assert(
		"conflicting file reviews are detected",
		!conflictResult.accepted &&
			conflictResult.reasons.some((r) =>
				r.includes("Conflicting file reviews"),
			),
		"conflicting reviews should fail",
	);

	// Blocking findings
	const blockingFindingResult = evaluateVerification(
		makeReport({
			findings: [{ id: "f-1", severity: "blocking", summary: "Critical bug" }],
		}),
		makeManifest(),
		requiredCriteria,
	);
	assert(
		"blocking findings prevent acceptance",
		!blockingFindingResult.accepted &&
			blockingFindingResult.reasons.some((r) =>
				r.includes("Blocking findings"),
			),
		"blocking findings should fail",
	);

	// Non-blocking warning findings are acceptable
	const warningFindingResult = evaluateVerification(
		makeReport({
			findings: [
				{ id: "f-1", severity: "warning", summary: "Minor style issue" },
			],
		}),
		makeManifest(),
		requiredCriteria,
	);
	assert(
		"warning findings alone do not prevent acceptance",
		warningFindingResult.accepted,
		"warning findings should be acceptable",
	);

	// Verifier recommends accept but failed evidence blocks it
	const acceptWithFailures = evaluateVerification(
		makeReport({
			recommendation: "accept",
			findings: [{ id: "f-1", severity: "blocking", summary: "Bug" }],
		}),
		makeManifest(),
		requiredCriteria,
	);
	assert(
		"recommendation=accept with blocking findings still rejected",
		!acceptWithFailures.accepted,
		"deterministic check should override recommendation",
	);

	// VerifiedArtifact construction
	const va = createVerifiedArtifact("digest-1", "report-id-1");
	assert(
		"VerifiedArtifact has correct kind",
		va.kind === "verified-artifact" &&
			va.manifestDigest === "digest-1" &&
			va.verificationReportId === "report-id-1",
		"created VerifiedArtifact should have correct fields",
	);

	assert(
		"VerifiedArtifact has exactFileCoverage = true",
		va.exactFileCoverage === true,
		"exactFileCoverage must be true",
	);

	assert(
		"VerifiedArtifact has allRequiredCriteriaPassed = true",
		va.allRequiredCriteriaPassed === true,
		"allRequiredCriteriaPassed must be true",
	);

	// Property: removing any one required item must fail
	{
		const fullManifest = makeManifest({
			changes: [
				{ status: "modified", path: "src/a.ts", contentDigest: "d1" },
				{ status: "modified", path: "src/b.ts", contentDigest: "d2" },
				{ status: "modified", path: "src/c.ts", contentDigest: "d3" },
			],
		});
		const fullReport = makeReport({
			subjectManifestDigest: fullManifest.manifestDigest,
			reviewedFiles: [
				{ path: "src/a.ts", status: "accepted", findingIds: [] },
				{ path: "src/b.ts", status: "accepted", findingIds: [] },
				{ path: "src/c.ts", status: "accepted", findingIds: [] },
			],
			criterionResults: [
				{ criterionId: "c1", status: "passed", evidenceRefs: [] },
				{ criterionId: "c2", status: "passed", evidenceRefs: [] },
				{ criterionId: "c3", status: "passed", evidenceRefs: [] },
			],
		});
		const fullCriteria = ["c1", "c2", "c3"];

		assert(
			"full valid report passes",
			evaluateVerification(fullReport, fullManifest, fullCriteria).accepted,
			"baseline should pass",
		);

		// Remove one file review
		const missingOneFile = evaluateVerification(
			{
				...fullReport,
				reviewedFiles: fullReport.reviewedFiles.slice(0, 2),
			},
			fullManifest,
			fullCriteria,
		);
		assert(
			"removing one file review fails",
			!missingOneFile.accepted,
			"missing file review should fail",
		);

		// Remove one criterion from report
		const missingOneCritReport = {
			...fullReport,
			criterionResults: fullReport.criterionResults.slice(0, 2),
		};
		const missingOneCritResult = evaluateVerification(
			missingOneCritReport,
			fullManifest,
			fullCriteria,
		);
		assert(
			"removing one criterion result fails",
			!missingOneCritResult.accepted,
			"missing criterion should fail",
		);

		// Fail one criterion
		const failedOneCritReport = {
			...fullReport,
			criterionResults: fullReport.criterionResults.map((cr, i) =>
				i === 0 ? { ...cr, status: "failed" as const } : cr,
			),
		};
		const failedOneCritResult = evaluateVerification(
			failedOneCritReport,
			fullManifest,
			fullCriteria,
		);
		assert(
			"one failed criterion fails verification",
			!failedOneCritResult.accepted,
			"failed criterion should fail",
		);
	}
});

// ═══════════════════════════════════════════════
// 4. Handoff service tests
// ═══════════════════════════════════════════════

import {
	processHandoff,
	inferRoleFromAgent,
} from "../config/phenix-pi/pi/extensions/phenix-flow/handoff/service";
import type {
	HandoffKind,
	PhaseRole,
} from "../config/phenix-pi/pi/extensions/phenix-flow/handoff/schemas";

describe("Handoff service", () => {
	const expected = {
		role: "scout" as PhaseRole,
		artifactKind: "scout-result" as HandoffKind,
		stepId: "Gather local context",
		effectId: "run-1:0:Context:0",
		attempt: 1,
	};

	const validSubmission = {
		kind: "scout-result",
		schemaVersion: 1,
		runId: "run-1",
		stepId: "Gather local context",
		effectId: "run-1:0:Context:0",
		attempt: 1,
		relevantFiles: ["src/index.ts"],
		editPoints: [{ file: "src/index.ts", reason: "Add exports" }],
		constraints: [],
		risks: [],
		recommendation: "planned",
	};

	// Helper to extract rejection from a processHandoff result
	function getKind(result: ReturnType<typeof processHandoff>): string {
		if (!("rejection" in result && !result.accepted)) return "accepted";
		const r = result as {
			accepted: false;
			rejection: import("../config/phenix-pi/pi/extensions/phenix-flow/handoff/errors").HandoffRejection;
		};
		return r.rejection.kind;
	}
	// Schema invalid
	{
		const result = processHandoff({ invalid: true }, expected, "run-1", "/tmp");
		assert(
			"invalid submission schema is rejected",
			getKind(result) === "schema-invalid",
			`schema-invalid (got ${getKind(result)})`,
		);
	}

	// Wrong run ID
	{
		const result = processHandoff(
			{ ...validSubmission, runId: "wrong-run" },
			expected,
			"run-1",
			"/tmp",
		);
		assert(
			"wrong run ID is rejected",
			getKind(result) === "stale-run",
			"stale-run",
		);
	}

	// Wrong step ID
	{
		const result = processHandoff(
			{ ...validSubmission, stepId: "wrong-step" },
			expected,
			"run-1",
			"/tmp",
		);
		assert(
			"wrong step ID is rejected",
			getKind(result) === "stale-step",
			"stale-step",
		);
	}

	// Wrong effect ID
	{
		const result = processHandoff(
			{ ...validSubmission, effectId: "wrong-effect" },
			expected,
			"run-1",
			"/tmp",
		);
		assert(
			"wrong effect ID is rejected",
			getKind(result) === "stale-effect",
			"stale-effect",
		);
	}

	// Wrong attempt
	{
		const result = processHandoff(
			{ ...validSubmission, attempt: 5 },
			expected,
			"run-1",
			"/tmp",
		);
		assert(
			"wrong attempt is rejected",
			getKind(result) === "stale-attempt",
			"stale-attempt",
		);
	}

	// Wrong role (submit worker result when scout expected)
	{
		const result = processHandoff(
			{
				kind: "worker-result",
				schemaVersion: 1,
				runId: "run-1",
				stepId: "Gather local context",
				effectId: "run-1:0:Context:0",
				attempt: 1,
				summary: "test",
				completedPlanSteps: [],
				claimedChangedFiles: [],
				unresolvedIssues: [],
				verificationNotes: [],
			},
			expected,
			"run-1",
			"/tmp",
		);
		assert(
			"wrong role is rejected",
			getKind(result) === "wrong-role",
			"wrong-role",
		);
	}

	// Wrong artifact kind: submit a plan with plan fields but expected kind is scout-result
	{
		const wrongKindResult = processHandoff(
			{
				kind: "plan",
				schemaVersion: 1,
				runId: "run-1",
				stepId: "Gather local context",
				effectId: "run-1:0:Context:0",
				attempt: 1,
				objective: "Test",
				steps: [{ id: "s1", action: "test" }],
				acceptanceCriteria: [{ id: "c1", requirement: "r", check: "c" }],
				nonGoals: [],
			},
			expected,
			"run-1",
			"/tmp",
		);
		const kind = getKind(wrongKindResult);
		assert(
			"wrong artifact kind is rejected (or caught by role check first)",
			kind === "wrong-artifact-kind" || kind === "wrong-role",
			`rejection: ${kind}`,
		);
	}

	// Unknown keys
	{
		const result = processHandoff(
			{ ...validSubmission, extraField: "value" },
			expected,
			"run-1",
			"/tmp",
		);
		assert(
			"unknown keys are rejected",
			getKind(result) === "unknown-keys",
			"unknown-keys",
		);
	}

	// Valid plan submission
	{
		const result = processHandoff(
			{
				kind: "plan",
				schemaVersion: 1,
				runId: "run-1",
				stepId: "plan-id",
				effectId: "plan-eff-1",
				attempt: 1,
				objective: "Test plan",
				steps: [{ id: "s1", action: "do something" }],
				acceptanceCriteria: [{ id: "c1", requirement: "works", check: "test" }],
				nonGoals: [],
			},
			{
				role: "planner",
				artifactKind: "plan",
				stepId: "plan-id",
				effectId: "plan-eff-1",
				attempt: 1,
			},
			"run-1",
			"/tmp",
		);
		const kind = getKind(result);
		assert(
			"valid plan submission is accepted or fails at artifact store",
			kind === "accepted" || kind === "artifact-store-failure",
			`result: ${kind}`,
		);
	}
});

// ═══════════════════════════════════════════════
// 5. Role inference tests
// ═══════════════════════════════════════════════

describe("Role inference", () => {
	assert(
		"scout agent inferred as scout",
		inferRoleFromAgent("phenix-scout") === "scout",
		"phenix-scout → scout",
	);
	assert(
		"planner agent inferred as planner",
		inferRoleFromAgent("phenix-planner") === "planner",
		"phenix-planner → planner",
	);
	assert(
		"worker agent inferred as worker",
		inferRoleFromAgent("phenix-worker") === "worker",
		"phenix-worker → worker",
	);
	assert(
		"verifier agent inferred as verifier",
		inferRoleFromAgent("phenix-verifier") === "verifier",
		"phenix-verifier → verifier",
	);
	assert(
		"implementer inferred as worker",
		inferRoleFromAgent("implementer") === "worker",
		"implementer → worker",
	);
	assert(
		"unknown agent returns null",
		inferRoleFromAgent("some-other-agent") === null,
		"unknown → null",
	);
});

// ═══════════════════════════════════════════════
// 6. Error formatting
// ═══════════════════════════════════════════════

import { formatRejection } from "../config/phenix-pi/pi/extensions/phenix-flow/handoff/errors";

describe("Error formatting", () => {
	assert(
		"schema-invalid is formatted",
		formatRejection({
			kind: "schema-invalid",
			issues: [{ path: "kind", message: "required" }],
		}).startsWith("Schema validation failed"),
		"should produce readable error",
	);

	assert(
		"stale-run is formatted",
		formatRejection({
			kind: "stale-run",
			expected: "run-1",
			actual: "run-2",
		}).includes("Stale run ID"),
		"should mention stale run",
	);

	assert(
		"changed-file-mismatch is formatted",
		formatRejection({
			kind: "changed-file-mismatch",
			missing: ["a.ts"],
			unexpected: ["b.ts"],
		}).includes("Changed file mismatch"),
		"should mention file mismatch",
	);

	assert(
		"verification-incomplete is formatted",
		formatRejection({
			kind: "verification-incomplete",
			missingFiles: ["a.ts"],
			missingCriteria: ["c1"],
			failedCriteria: ["c2"],
		}).includes("Verification incomplete"),
		"should mention incomplete verification",
	);
});

// ═══════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════

const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`\n═══════════════════════════════════`);
console.log(
	`Results: ${passed} passed, ${failed} failed, ${results.length} total`,
);
console.log(`═══════════════════════════════════\n`);

if (failed > 0) {
	process.exit(1);
}
