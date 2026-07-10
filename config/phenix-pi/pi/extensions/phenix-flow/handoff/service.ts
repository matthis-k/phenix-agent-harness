/**
 * handoff/service.ts — Coordination service for handoff validation, storage, and event dispatch.
 *
 * The service orchestrates:
 *   schema validation → correlation check → semantic validation → artifact storage
 *
 * Pure functions with injected dependencies (filesystem, clock, ID generation).
 * No side effects outside the explicit parameters.
 */

import type { AwaitingHandoffState } from "../types.js";
import type {
	AcceptedArtifact,
	ArtifactId,
	HandoffKind,
	HandoffSubmission,
	PhaseRole,
	RepositoryManifest,
	WorkerResult,
	VerificationReport,
	RepairResult,
} from "./schemas.js";
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
} from "./schemas.js";
import type { HandoffRejection } from "./errors.js";
import { storeArtifact, initRun } from "./artifact-store.js";
import { generateManifest, compareClaims } from "./repository-manifest.js";
import { evaluateVerification } from "./verification-validator.js";

// ── Helpers ──

/**
 * Derive an authoritative manifest and compare against claimed files.
 * Returns a HandoffRejection on mismatch, or null if clean.
 */
function deriveAndCompareManifest(
	cwd: string,
	claimedChangedFiles: string[],
): HandoffRejection | null {
	let manifest: RepositoryManifest | null = null;
	try {
		manifest = generateManifest(cwd);
	} catch {
		return {
			kind: "artifact-store-failure",
			message: "Failed to derive repository manifest",
		};
	}

	if (manifest && manifest.changes.length > 0) {
		const { missing, unexpected } = compareClaims(
			manifest,
			claimedChangedFiles,
		);
		if (missing.length > 0 || unexpected.length > 0) {
			return { kind: "changed-file-mismatch", missing, unexpected };
		}
	}
	return null;
}

// ── Phase role extraction from agent name ──

/**
 * Infer the phase role from an agent name string.
 */
export function inferRoleFromAgent(agentName: string): PhaseRole | null {
	const lower = agentName.toLowerCase();
	if (lower.includes("scout")) return "scout";
	if (lower.includes("planner")) return "planner";
	if (lower.includes("worker") || lower.includes("implementer"))
		return "worker";
	if (lower.includes("verifier")) return "verifier";
	if (lower.includes("repair") || lower.includes("debugger")) return "repair";
	return null;
}

/**
 * Extract the expected handoff correlation from an awaiting-handoff state.
 */
export function extractExpected(state: AwaitingHandoffState): {
	role: PhaseRole;
	artifactKind: HandoffKind;
	stepId: string;
	effectId: string;
	attempt: number;
} {
	return state.expected;
}

// ═══════════════════════════════════════════════
// Handoff processing pipeline
// ═══════════════════════════════════════════════

/**
 * Process a handoff submission through the full validation pipeline.
 *
 * Steps:
 * 1. Schema validation (kind + identity)
 * 2. Unknown key rejection
 * 3. Correlation validation (run, step, effect, attempt, role)
 * 4. Payload-specific semantic checks
 * 5. Artifact storage
 *
 * Returns either an accepted artifact or a rejection.
 */

/** Check identity correlation against expected values. */
function checkIdentityCorrelation(
	identity: {
		runId: string;
		stepId: string;
		effectId: string;
		attempt: number;
	},
	kind: string,
	runId: string,
	expected: {
		role: string;
		artifactKind: string;
		stepId: string;
		effectId: string;
		attempt: number;
	},
): HandoffRejection | null {
	if (identity.runId !== runId)
		return { kind: "stale-run", expected: runId, actual: identity.runId };
	if (identity.stepId !== expected.stepId)
		return {
			kind: "stale-step",
			expected: expected.stepId,
			actual: identity.stepId,
		};
	if (identity.effectId !== expected.effectId)
		return {
			kind: "stale-effect",
			expected: expected.effectId,
			actual: identity.effectId,
		};
	if (identity.attempt !== expected.attempt)
		return {
			kind: "stale-attempt",
			expected: expected.attempt,
			actual: identity.attempt,
		};
	const submissionRole = HANDOFF_KIND_TO_ROLE[
		kind as keyof typeof HANDOFF_KIND_TO_ROLE
	] as PhaseRole;
	if (submissionRole !== expected.role)
		return {
			kind: "wrong-role",
			expected: expected.role as PhaseRole,
			actual: submissionRole,
		};
	if (kind !== expected.artifactKind)
		return {
			kind: "wrong-artifact-kind",
			expected: expected.artifactKind,
			actual: kind as any,
		};
	return null;
}

/** Run step 1–2: schema validation (kind + identity) and unknown keys check. */
function validateHandoffSchema(
	submissionJson: unknown,
):
	| {
			ok: true;
			kindCheck: { kind: HandoffKind };
			identity: {
				runId: string;
				stepId: string;
				effectId: string;
				attempt: number;
			};
	  }
	| { ok: false; rejection: HandoffRejection } {
	const kindCheck = validateKind(submissionJson);
	if (!kindCheck.ok)
		return {
			ok: false as const,
			rejection: {
				kind: "schema-invalid",
				issues: (kindCheck as { ok: false; errors: string[] }).errors.map(
					(m) => ({ path: "", message: m }),
				),
			},
		};
	const identityCheck = validateIdentity(submissionJson);
	if (!identityCheck.ok)
		return {
			ok: false as const,
			rejection: {
				kind: "schema-invalid",
				issues: (identityCheck as { ok: false; errors: string[] }).errors.map(
					(m) => ({ path: "", message: m }),
				),
			},
		};
	if (typeof submissionJson === "object" && submissionJson !== null) {
		const unknownKeys = findUnknownKeys(
			submissionJson as Record<string, unknown>,
		);
		if (unknownKeys.length > 0)
			return {
				ok: false as const,
				rejection: { kind: "unknown-keys", keys: unknownKeys },
			};
	}
	return {
		ok: true as const,
		kindCheck: kindCheck as { kind: HandoffKind },
		identity: identityCheck.identity,
	};
}

/** Run step 4: payload-specific validation. */
function validateHandoffPayload(
	kind: string,
	data: Record<string, unknown>,
	cwd: string,
	planCriterionIds?: string[],
): HandoffRejection | null {
	switch (kind) {
		case "scout-result":
			return checkScout(data);
		case "plan":
			return checkPlan(data);
		case "worker-result":
			return checkWorker(data, cwd);
		case "verification-report":
			return checkVerification(data, cwd, planCriterionIds);
		case "repair-result":
			return checkRepair(data, cwd);
		default:
			return {
				kind: "schema-invalid",
				issues: [{ path: "kind", message: `Unknown handoff kind: ${kind}` }],
			};
	}
}

/** Run step 5: store artifact and build accepted result. */
function storeHandoffArtifact(
	cwd: string,
	runId: string,
	submissionJson: unknown,
):
	| { ok: true; artifact: AcceptedArtifact }
	| { ok: false; rejection: HandoffRejection } {
	initRun(cwd, runId);
	try {
		const stored = storeArtifact(
			cwd,
			runId,
			submissionJson as HandoffSubmission,
		);
		return {
			ok: true,
			artifact: {
				kind: "accepted-artifact",
				artifactId: stored.artifactId as ArtifactId,
				payloadDigest: stored.payloadDigest,
				submission: submissionJson as HandoffSubmission,
			},
		};
	} catch (err) {
		return {
			ok: false,
			rejection: {
				kind: "artifact-store-failure",
				message: err instanceof Error ? err.message : String(err),
			},
		};
	}
}

export function processHandoff(
	submissionJson: unknown,
	expected: {
		role: PhaseRole;
		artifactKind: HandoffKind;
		stepId: string;
		effectId: string;
		attempt: number;
	},
	runId: string,
	cwd: string,
	planCriterionIds?: string[],
):
	| { accepted: false; rejection: HandoffRejection }
	| { accepted: true; artifact: AcceptedArtifact } {
	// Step 1–2: Schema + unknown keys
	const schemaResult:
		| { ok: false; rejection: HandoffRejection }
		| {
				ok: true;
				kindCheck: { kind: HandoffKind };
				identity: {
					runId: string;
					stepId: string;
					effectId: string;
					attempt: number;
				};
		  } = validateHandoffSchema(submissionJson);
	if (!schemaResult.ok)
		return {
			accepted: false,
			rejection: (schemaResult as { ok: false; rejection: HandoffRejection })
				.rejection,
		};
	const { kindCheck, identity } = schemaResult as {
		ok: true;
		kindCheck: { kind: HandoffKind };
		identity: {
			runId: string;
			stepId: string;
			effectId: string;
			attempt: number;
		};
	};

	// Step 3: Correlation
	const corrErr = checkIdentityCorrelation(
		identity,
		kindCheck.kind,
		runId,
		expected,
	);
	if (corrErr) return { accepted: false, rejection: corrErr };

	// Step 4: Payload validation
	const payloadErr = validateHandoffPayload(
		kindCheck.kind,
		submissionJson as Record<string, unknown>,
		cwd,
		planCriterionIds,
	);
	if (payloadErr) return { accepted: false, rejection: payloadErr };

	// Step 5: Store + build artifact
	const storeResult:
		| { ok: false; rejection: HandoffRejection }
		| { ok: true; artifact: AcceptedArtifact } = storeHandoffArtifact(
		cwd,
		runId,
		submissionJson,
	);
	if (!storeResult.ok)
		return {
			accepted: false,
			rejection: (storeResult as { ok: false; rejection: HandoffRejection })
				.rejection,
		};
	return {
		accepted: true,
		artifact: (storeResult as { ok: true; artifact: AcceptedArtifact })
			.artifact,
	};
}

// ── Validation helpers (extracted to avoid lexical declarations inside case blocks) ──

function checkScout(data: Record<string, unknown>): HandoffRejection | null {
	const r = validateScoutPayload(data);
	if ((r as { ok: false }).ok === false) {
		return {
			kind: "schema-invalid",
			issues: (r as { ok: false; errors: string[] }).errors.map((m) => ({
				path: "",
				message: m,
			})),
		};
	}
	return null;
}

function checkPlan(data: Record<string, unknown>): HandoffRejection | null {
	const r = validatePlanPayload(data);
	if ((r as { ok: false }).ok === false) {
		return {
			kind: "schema-invalid",
			issues: (r as { ok: false; errors: string[] }).errors.map((m) => ({
				path: "",
				message: m,
			})),
		};
	}
	return null;
}

function checkWorker(
	data: Record<string, unknown>,
	cwd: string,
): HandoffRejection | null {
	const r = validateWorkerPayload(data);
	if ((r as { ok: false }).ok === false) {
		return {
			kind: "schema-invalid",
			issues: (r as { ok: false; errors: string[] }).errors.map((m) => ({
				path: "",
				message: m,
			})),
		};
	}
	const vr = r as { ok: true; value: WorkerResult };
	return deriveAndCompareManifest(cwd, vr.value.claimedChangedFiles);
}

function checkVerification(
	data: Record<string, unknown>,
	cwd: string,
	planCriterionIds: string[] | undefined,
): HandoffRejection | null {
	const r = validateVerificationPayload(data);
	if ((r as { ok: false }).ok === false) {
		return {
			kind: "schema-invalid",
			issues: (r as { ok: false; errors: string[] }).errors.map((m) => ({
				path: "",
				message: m,
			})),
		};
	}

	const report = (r as { ok: true; value: VerificationReport }).value;

	let manifest: RepositoryManifest | null = null;
	try {
		manifest = generateManifest(cwd);
	} catch {
		return {
			kind: "artifact-store-failure",
			message: "Failed to derive repository manifest for verification",
		};
	}

	if (!manifest) return null;

	const verdict = evaluateVerification(
		report,
		manifest,
		planCriterionIds ?? [],
	);
	if (verdict.accepted) return null;

	// Map reasons to structured rejection
	const missingFiles: string[] = [];
	const missingCriteria: string[] = [];
	const failedCriteria: string[] = [];

	for (const reason of verdict.reasons) {
		if (reason.startsWith("Missing file reviews"))
			missingFiles.push(...extractList(reason));
		else if (reason.startsWith("Missing criteria results"))
			missingCriteria.push(...extractList(reason));
		else if (reason.startsWith("Failed criteria"))
			failedCriteria.push(...extractList(reason));
	}

	if (
		missingFiles.length > 0 ||
		missingCriteria.length > 0 ||
		failedCriteria.length > 0
	) {
		return {
			kind: "verification-incomplete",
			missingFiles,
			missingCriteria,
			failedCriteria,
		};
	}

	return {
		kind: "verification-stale",
		expectedManifest: manifest.manifestDigest,
		actualManifest: report.subjectManifestDigest,
	};
}

function checkRepair(
	data: Record<string, unknown>,
	cwd: string,
): HandoffRejection | null {
	const r = validateRepairPayload(data);
	if ((r as { ok: false }).ok === false) {
		return {
			kind: "schema-invalid",
			issues: (r as { ok: false; errors: string[] }).errors.map((m) => ({
				path: "",
				message: m,
			})),
		};
	}
	const vr = r as { ok: true; value: RepairResult };
	return deriveAndCompareManifest(cwd, vr.value.claimedChangedFiles);
}

/**
 * Extract a comma-separated list from a reason string.
 * Format: "prefix: item1, item2, item3"
 */
function extractList(reason: string): string[] {
	const colon = reason.indexOf(":");
	if (colon === -1) return [];
	return reason
		.slice(colon + 1)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
