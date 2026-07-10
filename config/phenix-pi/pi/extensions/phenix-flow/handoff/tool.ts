/**
 * handoff/tool.ts — Pi extension tool registration for `phenix_handoff`.
 *
 * Registers one tool that agents call to submit their phase results.
 * The tool validates the submission through the full pipeline and returns
 * an accepted/rejected result.
 */

import { Type, type Static } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import type { AwaitingHandoffState } from "../types.js";
import { processHandoff } from "./service.js";
import { type HandoffRejection, rejectionResult } from "./errors.js";

// ── Tool parameter schema (simple JSON string to avoid TypeBox type issues) ──

const HandoffToolParams = Type.Object({
	submission: Type.String({
		description:
			"JSON string containing the complete handoff submission. Must include kind, schemaVersion, runId, stepId, effectId, attempt, and kind-specific fields.",
	}),
});

type HandoffToolParams = Static<typeof HandoffToolParams>;

// ── Module-level state reference for the tool to access expected handoff ──

interface ToolState {
	getState: () => AwaitingHandoffState | null;
	getPlanCriterionIds?: () => string[];
}

let toolState: ToolState | null = null;

/**
 * Set the tool state reference. Called by the extension when entering awaiting-handoff.
 */
export function setToolState(state: ToolState): void {
	toolState = state;
}

/**
 * Clear the tool state reference.
 */
export function clearToolState(): void {
	toolState = null;
}

// ── Tool execution ──

/**
 * Execute the phenix_handoff tool.
 *
 * The tool:
 * 1. Checks that we're in an awaiting-handoff state
 * 2. Parses the submission JSON
 * 3. Runs the full validation pipeline
 * 4. Returns accepted or rejected result to the agent
 * 5. On acceptance, stores the accepted artifact for the agent_end handler
 */
async function executeHandoffTool(
	_toolCallId: string,
	params: HandoffToolParams,
	_signal: AbortSignal | undefined,
	_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	// ── Check state ──
	if (!toolState) {
		return rejectionResult({
			kind: "unexpected-submission",
			message: "No active workflow phase expecting a handoff",
		});
	}

	const state = toolState.getState();
	if (!state || state.tag !== "awaiting-handoff") {
		return rejectionResult({
			kind: "unexpected-submission",
			message: "No active workflow phase expecting a handoff",
		});
	}

	// ── Parse submission JSON ──
	let parsed: unknown;
	try {
		parsed = JSON.parse(params.submission);
	} catch (err) {
		return rejectionResult({
			kind: "schema-invalid",
			issues: [
				{
					path: "submission",
					message: err instanceof Error ? err.message : "Invalid JSON",
				},
			],
		});
	}

	// ── Run validation pipeline ──
	const criterionIds = toolState.getPlanCriterionIds?.() ?? [];
	const result = processHandoff(
		parsed,
		state.expected,
		state.runId,
		ctx.cwd,
		criterionIds,
	);

	if (result.accepted) {
		// Store pending artifact for the agent_end handler
		pendingAcceptedArtifact = result.artifact;
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						accepted: true,
						artifactId: result.artifact.artifactId,
						payloadDigest: result.artifact.payloadDigest,
					}),
				},
			],
			details: null,
		};
	}

	// Rejected — return structured error
	const rejection = (
		result as {
			accepted: false;
			rejection: HandoffRejection;
		}
	).rejection;
	return rejectionResult(rejection);
}

// ── Pending artifact (set by tool on acceptance, consumed by agent_end handler) ──

import type { AcceptedArtifact } from "./schemas.js";

let pendingAcceptedArtifact: AcceptedArtifact | null = null;

/**
 * Get and clear the pending accepted artifact.
 * Called by the agent_end handler in the extension adapter.
 */
export function consumePendingArtifact(): AcceptedArtifact | null {
	const artifact = pendingAcceptedArtifact;
	pendingAcceptedArtifact = null;
	return artifact;
}

// ── Tool registration ──

/**
 * Register the phenix_handoff tool with the Pi extension API.
 */
export function registerHandoffTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "phenix_handoff",
		label: "Phenix Handoff",
		description:
			"Submit your phase handoff artifact. The tool validates your submission, " +
			"checks workflow correlation, stores an immutable artifact, and returns " +
			"acceptance or rejection. This is the ONLY way to complete a phase.",
		parameters: HandoffToolParams,
		execute: executeHandoffTool,
	});
}
