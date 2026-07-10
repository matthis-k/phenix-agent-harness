/**
 * handoff.ts — MCP-based durable handoff for workflow phase artifacts.
 *
 * Each phase output is recorded as an MCP artifact via the
 * phenix-agent-comm-mcp server. The session is initialised at workflow
 * start and each phase output is stored as a named artifact.
 *
 * All MCP calls are non-fatal: failures are silently caught so that the
 * workflow continues even without the MCP server.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Initialize an MCP communication session for a workflow run.
 * Returns the session ID or "default" if MCP is unavailable.
 */
export function initMcpSession(runId: string): string {
	try {
		const args = JSON.stringify({
			name: `phenix-flow-${runId}`,
		});
		const result = execSync(
			`phenix-agent-comm-mcp tool comm_session_init --args '${args}'`,
			{ timeout: 10000, encoding: "utf-8", windowsHide: true },
		);
		const parsed = JSON.parse(result.toString());
		// Accept standard JSON-RPC response shape
		if (typeof parsed.id === "string" && parsed.id) return parsed.id;
		if (typeof parsed.session_id === "string" && parsed.session_id)
			return parsed.session_id;
		if (typeof parsed.result?.id === "string") return parsed.result.id;
		// ponytail: one session ID is enough, add format support when needed
		return "default";
	} catch {
		return "default";
	}
}

/**
 * Record a phase output artifact via the phenix-agent-comm MCP server.
 *
 * The artifact references the output file on disk (content_ref).
 * Non-fatal: failures are silently caught.
 */
export function recordMcpArtifact(
	sessionId: string,
	label: string,
	phaseKind: string,
	filePath: string | undefined,
	cwd: string,
): void {
	if (!filePath || sessionId === "default") return;

	try {
		const resolvedPath = resolve(cwd, filePath);
		const args = JSON.stringify({
			session_id: sessionId,
			name: label,
			kind: `phase-${phaseKind}`,
			content_ref: resolvedPath,
		});
		execSync(
			`phenix-agent-comm-mcp tool comm_artifact_record --args '${args}'`,
			{ timeout: 5000, stdio: "ignore", windowsHide: true },
		);
	} catch {
		// Non-fatal: MCP may not be available
	}
}
