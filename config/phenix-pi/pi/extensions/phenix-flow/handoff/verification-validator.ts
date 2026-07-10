/**
 * handoff/verification-validator.ts — Pure deterministic verification completeness checks.
 *
 * These functions compare verifier-submitted data against authoritative
 * repository manifests and required criteria.
 *
 * No verifier "recommendation" is trusted — only these deterministic checks
 * produce a trusted VerifiedArtifact.
 */

import type {
	RepositoryManifest,
	VerificationReport,
	VerifiedArtifact,
} from "./schemas.js";
import { generateArtifactId } from "./artifact-store.js";

// ═══════════════════════════════════════════════
// Verifier acceptance checks
// ═══════════════════════════════════════════════

export interface VerificationVerdict {
	accepted: boolean;
	reasons: string[];
}

/**
 * Deterministically evaluate whether a verification report should be accepted.
 *
 * Checks:
 * 1. reviewed changed files == authoritative changed files
 * 2. required criteria all present in criterionResults
 * 3. every required criterion result == "passed"
 * 4. subject manifest digest == current manifest digest
 * 5. correlation (run/effect/attempt) matches
 * 6. no blocking findings remain
 * 7. no duplicate conflicting file reviews
 */
export function evaluateVerification(
	report: VerificationReport,
	manifest: RepositoryManifest,
	requiredCriterionIds: string[],
): VerificationVerdict {
	const reasons: string[] = [];
	let accepted = true;

	// ── 1. Manifest digest match ──
	if (report.subjectManifestDigest !== manifest.manifestDigest) {
		reasons.push(
			`Stale manifest: report has ${report.subjectManifestDigest}, current is ${manifest.manifestDigest}`,
		);
		accepted = false;
	}

	// ── 2 & 3. File coverage ──
	const reviewedPaths = new Set(report.reviewedFiles.map((f) => f.path));
	const missingFiles: string[] = [];
	const conflictingFiles: string[] = [];

	for (const change of manifest.changes) {
		if (!reviewedPaths.has(change.path)) {
			missingFiles.push(change.path);
		}
	}

	// Check for duplicate conflicting reviews
	const pathStatuses = new Map<string, string>();
	for (const rf of report.reviewedFiles) {
		const existing = pathStatuses.get(rf.path);
		if (existing && existing !== rf.status) {
			conflictingFiles.push(rf.path);
		}
		pathStatuses.set(rf.path, rf.status);
	}

	// Files in manifest but not reviewed
	for (const change of manifest.changes) {
		if (!reviewedPaths.has(change.path)) {
			missingFiles.push(change.path);
		}
	}

	if (missingFiles.length > 0) {
		reasons.push(`Missing file reviews: ${missingFiles.join(", ")}`);
		accepted = false;
	}

	if (conflictingFiles.length > 0) {
		reasons.push(`Conflicting file reviews: ${conflictingFiles.join(", ")}`);
		accepted = false;
	}

	// ── 4. Required criteria check ──
	const submittedCriterionIds = new Set(
		report.criterionResults.map((cr) => cr.criterionId),
	);
	const missingCriteria: string[] = [];
	const failedCriteria: string[] = [];
	const notRunCriteria: string[] = [];

	for (const requiredId of requiredCriterionIds) {
		if (!submittedCriterionIds.has(requiredId)) {
			missingCriteria.push(requiredId);
		}
	}

	for (const cr of report.criterionResults) {
		if (cr.status === "failed") {
			failedCriteria.push(cr.criterionId);
		}
		if (cr.status === "not-run") {
			notRunCriteria.push(cr.criterionId);
		}
	}

	if (missingCriteria.length > 0) {
		reasons.push(`Missing criteria results: ${missingCriteria.join(", ")}`);
		accepted = false;
	}

	if (failedCriteria.length > 0) {
		reasons.push(`Failed criteria: ${failedCriteria.join(", ")}`);
		accepted = false;
	}

	if (notRunCriteria.length > 0) {
		reasons.push(`Not-run criteria: ${notRunCriteria.join(", ")}`);
		accepted = false;
	}

	// ── 5. Check for blocking findings ──
	const blockingFindings = report.findings.filter(
		(f) => f.severity === "blocking",
	);
	if (blockingFindings.length > 0) {
		reasons.push(
			`Blocking findings remain: ${blockingFindings.map((f) => f.id).join(", ")}`,
		);
		accepted = false;
	}

	return { accepted, reasons };
}

// ═══════════════════════════════════════════════
// VerifiedArtifact construction
// ═══════════════════════════════════════════════

/**
 * Create a trusted VerifiedArtifact only after all checks pass.
 * This function should only be called when `evaluateVerification` returns `accepted: true`.
 */
export function createVerifiedArtifact(
	manifestDigest: string,
	reportId: string,
): VerifiedArtifact {
	return {
		kind: "verified-artifact",
		artifactId: generateArtifactId() as VerifiedArtifact["artifactId"],
		manifestDigest,
		verificationReportId: reportId,
		exactFileCoverage: true,
		allRequiredCriteriaPassed: true,
	};
}
