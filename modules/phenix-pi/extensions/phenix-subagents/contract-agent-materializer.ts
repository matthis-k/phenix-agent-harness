import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import os from "node:os";

import type { ContractArtifact } from "./contract.ts";
import type { AgentKind } from "./agent-types.ts";

// ── Materialized agent result ───────────────────────────────────────────────

export interface MaterializedAgent {
  readonly runtimeName: string;
  readonly definitionPath: string;
  readonly leaseDir: string;
}

// ── Safe ID ─────────────────────────────────────────────────────────────────

function safeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 128);
}

// ── Persona loading ─────────────────────────────────────────────────────────

function resolveBundledAgentsDir(): string {
  return fileURLToPath(new URL("../../agents", import.meta.url));
}

function readPersonaBody(agentKind: AgentKind): string {
  const agentsDir = resolveBundledAgentsDir();
  const filePath = path.join(agentsDir, `${agentKind}.md`);

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(
      `Bundled agent definition not found: ${filePath}`,
    );
  }

  // Parse only the leading frontmatter.
  if (!content.startsWith("---")) {
    // No frontmatter — use the entire file as the persona body.
    return content.trimStart();
  }

  const endOfFrontmatter = content.indexOf("---", 3);
  if (endOfFrontmatter === -1) {
    // Malformed frontmatter — no closing ---. Use entire content.
    return content.trimStart();
  }

  const body = content.slice(endOfFrontmatter + 3).trim();
  if (!body) {
    throw new Error(
      `Agent ${agentKind} has no persona body after frontmatter.`,
    );
  }

  return body;
}

// ── Tool list formatting ────────────────────────────────────────────────────

/**
 * Format the effective + runtime tools as a comma-separated scalar.
 * The pinned Pi parser reads `tools` as a comma-separated scalar,
 * not as a YAML list.
 *
 * Expands wildcard selectors to concrete tool names where needed.
 * The runtime guard is the authoritative check; the agent definition
 * provides discovery hints.
 */
function formatToolsList(
  contract: ContractArtifact,
): string {
  const runtimeTools = ["phenix_complete"];
  const effective = contract.runtime.tools.effective;

  // Combine effective tools with runtime tools, deduplicating.
  const seen = new Set<string>();
  const all: string[] = [];
  for (const tool of [...effective, ...runtimeTools]) {
    if (!seen.has(tool)) {
      seen.add(tool);
      all.push(tool);
    }
  }

  return all.join(", ");
}

// ── Agent definition generation ─────────────────────────────────────────────

/**
 * Generate a materialized agent definition for the given contract.
 *
 * Uses the pinned Pi frontmatter format (comma-separated `tools` scalar).
 * The runtime name follows the pattern: phenix-runtime.contract-<safe-id>
 */
function generateAgentDefinition(
  contract: ContractArtifact,
  runtimeName: string,
): string {
  const personaBody = contract.identity.role !== null
    ? readPersonaBody(contract.identity.role as AgentKind)
    : "You are a minimal, bounded Phenix child agent. Complete the assigned task using your authorized tools and call phenix_complete when finished.";

  const toolsList = formatToolsList(contract);
  const thinking = contract.runtime.thinking;

  const lines: string[] = [];

  lines.push("---");
  lines.push(`name: ${runtimeName}`);
  lines.push("package: phenix-runtime");
  lines.push("description: Contract-bound Phenix child");
  lines.push(`tools: ${toolsList}`);
  lines.push(`thinking: ${thinking}`);
  lines.push("systemPromptMode: replace");
  lines.push("inheritProjectContext: true");
  lines.push("inheritSkills: true");
  lines.push("completionGuard: false");
  lines.push(
    `maxSubagentDepth: ${contract.runtime.delegation.remainingDepth}`,
  );
  lines.push("---");
  lines.push("");
  lines.push(personaBody);
  lines.push("");

  return lines.join("\n");
}

// ── Lease management ────────────────────────────────────────────────────────

/**
 * Create a temporary lease directory for the materialized agent definition.
 * Mode 0700 directory, mode 0600 file.
 * Returns the lease directory path and the definition file path.
 */
function createLease(
  contractId: string,
  definition: string,
): { leaseDir: string; definitionPath: string } {
  const leaseDir = path.join(
    os.tmpdir(),
    `phenix-agent-lease-${safeId(contractId)}-${randomUUID().slice(0, 8)}`,
  );

  fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });

  const definitionPath = path.join(leaseDir, "agent.md");

  fs.writeFileSync(definitionPath, definition, {
    mode: 0o600,
  });

  return { leaseDir, definitionPath };
}

/**
 * Release a lease directory. Cleans up the temporary agent definition.
 * Safe to call multiple times — handles missing directories gracefully.
 */
function releaseLease(leaseDir: string): void {
  try {
    fs.rmSync(leaseDir, { recursive: true, force: true });
  } catch {
    // Already cleaned or never created — safe to ignore.
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Materialize a contract-specific agent definition into a temporary lease.
 *
 * Returns the materialized agent with its runtime name, definition path,
 * and lease directory.
 *
 * The caller is responsible for releasing the lease via `releaseMaterializedAgent()`
 * after the child has been spawned (success or failure).
 */
export function materializeContractAgent(
  contract: ContractArtifact,
): MaterializedAgent {
  const runtimeName = `contract-${safeId(contract.id)}`;

  const definition = generateAgentDefinition(contract, runtimeName);

  const { leaseDir, definitionPath } = createLease(
    contract.id,
    definition,
  );

  return {
    runtimeName: `phenix-runtime.${runtimeName}`,
    definitionPath,
    leaseDir,
  };
}

/**
 * Release a materialized agent lease.
 * Cleans up the temporary directory and agent definition file.
 */
export function releaseMaterializedAgent(
  materialized: MaterializedAgent,
): void {
  releaseLease(materialized.leaseDir);
}
