/**
 * phenix-flow/contracts.ts — Zod schemas for phase output validation.
 *
 * Each phase role (scout, planner, worker, verifier) has a schema that
 * validates its JSON output at the adapter boundary. Schemas produce
 * structured errors and infer TypeScript types.
 */

import { z } from "zod";

// ═══════════════════════════════════════════════
// PER-ROLE OUTPUT SCHEMAS
// ═══════════════════════════════════════════════

export const ScoutOutputSchema = z
	.object({
		kind: z.string(),
		runId: z.string(),
		relevantFiles: z.array(z.string()).optional(),
		likelyEditPoints: z
			.array(
				z.object({
					file: z.string(),
					description: z.string(),
				}),
			)
			.optional(),
		risks: z.array(z.string()).optional(),
		confidence: z.string().optional(),
		recommendedDifficulty: z.string().optional(),
		taskAlreadySatisfied: z.boolean().optional(),
	})
	.strict();

export const PlannerOutputSchema = z
	.object({
		kind: z.string(),
		runId: z.string(),
		subtasks: z
			.array(
				z.object({
					id: z.number().optional(),
					file: z.string().optional(),
					action: z.string().optional(),
					change: z.string().optional(),
					reason: z.string().optional(),
				}),
			)
			.optional(),
		acceptanceCriteria: z
			.array(
				z.object({
					id: z.number().optional(),
					description: z.string().optional(),
					test: z.string().optional(),
				}),
			)
			.optional(),
		nonGoals: z.array(z.string()).optional(),
		requiredVerification: z
			.array(
				z.object({
					id: z.number().optional(),
					type: z.string().optional(),
					description: z.string().optional(),
					evidence: z.string().optional(),
				}),
			)
			.optional(),
	})
	.strict();

export const WorkerOutputSchema = z
	.object({
		kind: z.string(),
		runId: z.string(),
		changedFiles: z.array(z.string()),
		summary: z.string(),
	})
	.strict();

export const VerifierOutputSchema = z
	.object({
		kind: z.string(),
		runId: z.string(),
		status: z.enum(["pass", "fail"]),
		evidence: z
			.array(
				z.object({
					criteriaId: z.string().optional(),
					description: z.string().optional(),
					result: z.string().optional(),
					detail: z.string().optional(),
				}),
			)
			.optional(),
	})
	.strict();

// ═══════════════════════════════════════════════
// INFERRED TYPES
// ═══════════════════════════════════════════════

export type ScoutOutput = z.infer<typeof ScoutOutputSchema>;
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;
export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;

/** Discriminated union — narrow by `output.kind`. */
export type PhaseOutput =
	| ScoutOutput
	| PlannerOutput
	| WorkerOutput
	| VerifierOutput;

/** Roles that have contract schemas. */
export type PhaseRole = "scout" | "planner" | "worker" | "verifier";

// ═══════════════════════════════════════════════
// ROLE DETECTION
// ═══════════════════════════════════════════════

const ROLE_PATTERNS: Record<PhaseRole, string[]> = {
	scout: ["scout"],
	planner: ["planner"],
	worker: ["worker", "implementer"],
	verifier: ["verifier"],
};

/**
 * Detect the phase role from an agent name.
 * Returns the role string or null if the agent has no contract.
 */
export function detectRole(agent: string): PhaseRole | null {
	for (const [role, patterns] of Object.entries(ROLE_PATTERNS)) {
		for (const pat of patterns) {
			if (agent.includes(pat)) return role as PhaseRole;
		}
	}
	return null;
}

// ═══════════════════════════════════════════════
// SCHEMA LOOKUP
// ═══════════════════════════════════════════════

const SCHEMAS: Record<PhaseRole, z.ZodType<PhaseOutput>> = {
	scout: ScoutOutputSchema,
	planner: PlannerOutputSchema,
	worker: WorkerOutputSchema,
	verifier: VerifierOutputSchema,
};

// ═══════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════

export interface ValidPhaseOutput {
	success: true;
	data: PhaseOutput;
}

export interface InvalidPhaseOutput {
	success: false;
	reason: string;
}

export type ValidationResult = ValidPhaseOutput | InvalidPhaseOutput;

/**
 * Format a ZodError into a human-readable string matching the style
 * of the old checkPhaseContract messages.
 */
function formatError(role: PhaseRole, error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const field = issue.path.join(".");
			// Preserve exact format: "Worker output missing required key "changedFiles""
			if (
				issue.code === "invalid_type" &&
				"received" in issue &&
				issue.received === "undefined"
			) {
				return `${capitalize(role)} output missing required key "${field}"`;
			}
			if (field) {
				return `${capitalize(role)} output: ${field} — ${issue.message}`;
			}
			return `${capitalize(role)} output: ${issue.message}`;
		})
		.join("; ");
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Validate parsed phase output against the schema for the given agent's role.
 *
 * Returns `{ success: true, data }` with typed data on success,
 * or `{ success: false, reason }` with a human-readable message on failure.
 *
 * If the agent has no contract (no matching role), validation passes for
 * any parseable object — phases without contracts are not constrained.
 */
export function validatePhaseOutput(
	agent: string,
	parsed: Record<string, unknown>,
): ValidationResult {
	const role = detectRole(agent);
	if (!role) {
		// No contract for this role — pass through
		return { success: true, data: parsed as PhaseOutput };
	}

	const schema = SCHEMAS[role];
	const result = schema.safeParse(parsed);
	if (result.success) {
		return { success: true, data: result.data };
	}

	return {
		success: false,
		reason: formatError(role, result.error),
	};
}
