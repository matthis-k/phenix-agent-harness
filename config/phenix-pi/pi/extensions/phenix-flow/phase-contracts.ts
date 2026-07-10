/**
 * phase-contracts.ts — Runtime handoff contract config.
 *
 * Maps each phase role to the required top-level JSON keys that must
 * be present in its output. This is a simple field-existence check at
 * runtime — no Zod schemas, no nested validation.
 *
 * The config is used during handoff (agent_end handler) to verify that
 * a phase produced the expected fields before the next phase runs.
 *
 * To add a new phase role, just add its agent-prefix and required keys.
 */

/** Required top-level keys per agent name prefix. */
export const PHASE_CONTRACTS: Record<string, string[]> = {
	"phenix-scout": ["summary", "relevantFiles", "confidence"],
	"phenix-planner": ["goal", "subtasks", "acceptanceCriteria"],
	"phenix-worker": ["summary", "filesChanged", "needsVerifier"],
	"phenix-verifier": ["status"],
};

/**
 * Find matching contract keys for a phase agent name.
 * Checks each prefix — first match wins.
 * Returns null if no contract applies (freestyle phase).
 */
export function getRequiredKeys(agentName: string): string[] | null {
	for (const [prefix, keys] of Object.entries(PHASE_CONTRACTS)) {
		if (agentName.startsWith(prefix)) return keys;
	}
	return null;
}

/**
 * Verify a parsed phase output against its required keys.
 * Returns null on success, or a descriptive error string on failure.
 */
export function verifyPhaseOutput(
	agentName: string,
	output: Record<string, unknown>,
): string | null {
	const required = getRequiredKeys(agentName);
	if (!required) return null; // No contract for this phase → pass

	const missing = required.filter((key) => !(key in output));
	if (missing.length === 0) return null;

	return `"${agentName}" output missing required keys: ${missing.join(", ")}`;
}
