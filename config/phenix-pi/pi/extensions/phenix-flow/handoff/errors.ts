/**
 * handoff/errors.ts — Discriminated error union for handoff rejections.
 *
 * Every rejection has a structured kind that the tool returns to the agent.
 * No prose-only rejections.
 */

import type { PhaseRole } from "./schemas.js";

/** A single schema validation issue. */
export interface SchemaIssue {
	path: string;
	message: string;
}

/**
 * Discriminated union of all handoff rejection reasons.
 */
export type HandoffRejection =
	| {
			kind: "schema-invalid";
			issues: SchemaIssue[];
	  }
	| {
			kind: "unknown-keys";
			keys: string[];
	  }
	| {
			kind: "wrong-role";
			expected: PhaseRole;
			actual: PhaseRole;
	  }
	| {
			kind: "wrong-artifact-kind";
			expected: string;
			actual: string;
	  }
	| {
			kind: "stale-run";
			expected: string;
			actual: string;
	  }
	| {
			kind: "stale-step";
			expected: string;
			actual: string;
	  }
	| {
			kind: "stale-effect";
			expected: string;
			actual: string;
	  }
	| {
			kind: "stale-attempt";
			expected: number;
			actual: number;
	  }
	| {
			kind: "changed-file-mismatch";
			missing: string[];
			unexpected: string[];
	  }
	| {
			kind: "verification-incomplete";
			missingFiles: string[];
			missingCriteria: string[];
			failedCriteria: string[];
	  }
	| {
			kind: "verification-stale";
			expectedManifest: string;
			actualManifest: string;
	  }
	| {
			kind: "artifact-store-failure";
			message: string;
	  }
	| {
			kind: "missing-required-handoff";
			expectedArtifactKind: string;
			stepId: string;
			effectId: string;
	  }
	| {
			kind: "unexpected-submission";
			message: string;
	  };

/**
 * Format a rejection into a human-readable error message for agent feedback.
 */
export function formatRejection(rejection: HandoffRejection): string {
	switch (rejection.kind) {
		case "schema-invalid":
			return `Schema validation failed:\n${rejection.issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`;
		case "unknown-keys":
			return `Unknown keys in submission: ${rejection.keys.join(", ")}`;
		case "wrong-role":
			return `Wrong phase role: expected ${rejection.expected}, got ${rejection.actual}`;
		case "wrong-artifact-kind":
			return `Wrong artifact kind: expected ${rejection.expected}, got ${rejection.actual}`;
		case "stale-run":
			return `Stale run ID: expected ${rejection.expected}, got ${rejection.actual}`;
		case "stale-step":
			return `Stale step ID: expected ${rejection.expected}, got ${rejection.actual}`;
		case "stale-effect":
			return `Stale effect ID: expected ${rejection.expected}, got ${rejection.actual}`;
		case "stale-attempt":
			return `Stale attempt: expected ${rejection.expected}, got ${rejection.actual}`;
		case "changed-file-mismatch":
			return [
				"Changed file mismatch with repository:",
				...rejection.missing.map((f) => `  - Missing from claim: ${f}`),
				...rejection.unexpected.map((f) => `  - Not actually changed: ${f}`),
			].join("\n");
		case "verification-incomplete":
			return [
				"Verification incomplete:",
				...rejection.missingFiles.map((f) => `  - Missing file review: ${f}`),
				...rejection.missingCriteria.map(
					(c) => `  - Missing criterion result: ${c}`,
				),
				...rejection.failedCriteria.map((c) => `  - Failed criterion: ${c}`),
			].join("\n");
		case "verification-stale":
			return `Verification refers to stale manifest ${rejection.actualManifest}, expected ${rejection.expectedManifest}`;
		case "artifact-store-failure":
			return `Artifact store error: ${rejection.message}`;
		case "missing-required-handoff":
			return `Phase exited without a required handoff. Expected ${rejection.expectedArtifactKind} for step ${rejection.stepId}`;
		case "unexpected-submission":
			return `Unexpected submission: ${rejection.message}`;
	}
}

/**
 * Create a formatted tool result for a rejection.
 */
export function rejectionResult(rejection: HandoffRejection) {
	return {
		isError: true as const,
		content: [{ type: "text" as const, text: formatRejection(rejection) }],
		details: null,
	};
}
