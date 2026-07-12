import type { AgentRole, AgentKind } from "../phenix-subagents/agent-types.ts";
import { AGENT_KINDS } from "../phenix-subagents/agent-types.ts";
import type { DiscoveredAgentDefinition, AgentDiscoveryHelper } from "./capability-provider.ts";

// ── Default agent targets ───────────────────────────────────────────────────

export const DEFAULT_AGENT_TARGETS: ReadonlyArray<{
  readonly role: AgentRole;
  readonly logicalName: string;
  readonly runtimeName: string;
}> = [
  { role: null, logicalName: "base", runtimeName: "phenix.base" },
  { role: "scout", logicalName: "scout", runtimeName: "phenix.scout" },
  { role: "planner", logicalName: "planner", runtimeName: "phenix.planner" },
  { role: "architect", logicalName: "architect", runtimeName: "phenix.architect" },
  { role: "implementer", logicalName: "implementer", runtimeName: "phenix.implementer" },
  { role: "tester", logicalName: "tester", runtimeName: "phenix.tester" },
  { role: "critic", logicalName: "critic", runtimeName: "phenix.critic" },
  { role: "finalizer", logicalName: "finalizer", runtimeName: "phenix.finalizer" },
] as const;

// ── Capability entry ────────────────────────────────────────────────────────

export interface AgentCapabilityEntry {
  readonly role: AgentRole;
  readonly logicalName: string;
  readonly runtimeName: string;

  readonly configured: boolean;
  readonly spawnable: boolean;

  readonly source?: DiscoveredAgentDefinition["source"];
  readonly filePath?: string;

  readonly tools: readonly string[];

  readonly unavailableReason?: string;
}

// ── Capability artifact ─────────────────────────────────────────────────────

export interface AgentCapabilityArtifact {
  readonly version: 1;
  readonly generatedAt: string;

  /**
   * Hash of canonical agent capability content.
   * Do not include generatedAt in the hash.
   */
  readonly artifactHash: string;

  readonly entries: readonly AgentCapabilityEntry[];
}

// ── Build capability artifact ───────────────────────────────────────────────

import { createHash } from "node:crypto";

export function buildCapabilityArtifact(
  discovered: readonly DiscoveredAgentDefinition[],
): AgentCapabilityArtifact {
  const entries: AgentCapabilityEntry[] = [];
  const discoveredMap = new Map<string, DiscoveredAgentDefinition>();

  // Build a map of discovered agents by runtimeName
  for (const agent of discovered) {
    const existing = discoveredMap.get(agent.runtimeName);
    if (existing) {
      // Duplicate runtime name — this is an error
      throw new Error(
        `Duplicate runtime name "${agent.runtimeName}": ` +
        `found in source "${existing.source}" (path: ${existing.filePath ?? "unknown"}) ` +
        `and source "${agent.source}" (path: ${agent.filePath ?? "unknown"}). ` +
        `Each default Phenix agent runtime name must resolve to at most one effective agent.`,
      );
    }
    discoveredMap.set(agent.runtimeName, agent);
  }

  for (const target of DEFAULT_AGENT_TARGETS) {
    const discoveredAgent = discoveredMap.get(target.runtimeName);

    if (!discoveredAgent) {
      // Missing agent
      entries.push({
        role: target.role,
        logicalName: target.logicalName,
        runtimeName: target.runtimeName,
        configured: false,
        spawnable: false,
        tools: [],
        unavailableReason: `Agent "${target.runtimeName}" was not discovered at startup. ` +
          `Check that the agent definition exists and is not disabled.`,
      });
    } else if (discoveredAgent.disabled) {
      entries.push({
        role: target.role,
        logicalName: target.logicalName,
        runtimeName: target.runtimeName,
        configured: true,
        spawnable: false,
        source: discoveredAgent.source,
        filePath: discoveredAgent.filePath,
        tools: [],
        unavailableReason: `Agent "${target.runtimeName}" is disabled.`,
      });
    } else {
      entries.push({
        role: target.role,
        logicalName: target.logicalName,
        runtimeName: target.runtimeName,
        configured: true,
        spawnable: true,
        source: discoveredAgent.source,
        filePath: discoveredAgent.filePath,
        tools: [...discoveredAgent.tools],
      });
    }
  }

  // Compute hash from canonical content (exclude generatedAt)
  const canonicalContent = JSON.stringify(entries.map((e) => ({
    role: e.role,
    logicalName: e.logicalName,
    runtimeName: e.runtimeName,
    configured: e.configured,
    spawnable: e.spawnable,
    source: e.source,
    tools: e.tools,
    unavailableReason: e.unavailableReason,
  })), null, 2);

  const artifactHash = createHash("sha256")
    .update(canonicalContent, "utf-8")
    .digest("hex");

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    artifactHash,
    entries,
  };
}

// ── Query helpers ───────────────────────────────────────────────────────────

export function configuredAgent(
  artifact: AgentCapabilityArtifact,
  role: AgentRole,
): AgentCapabilityEntry | undefined {
  return artifact.entries.find((e) => e.role === role);
}

export function isSpawnableAgent(
  artifact: AgentCapabilityArtifact,
  role: AgentRole,
): boolean {
  const entry = configuredAgent(artifact, role);
  if (!entry) return false;
  return entry.spawnable;
}

// ── Persisted copy ──────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

// ── Fallback artifact for when discovery hasn't run ──────────────────────────────────────────

let _cachedArtifact: AgentCapabilityArtifact | undefined;

/** Set the runtime capability artifact (called by routing extension). */
export function setCachedCapabilityArtifact(artifact: AgentCapabilityArtifact): void {
  _cachedArtifact = artifact;
}

/** Get the cached artifact, or build a fallback with all defaults as spawnable. */
export function getCachedCapabilityArtifact(): AgentCapabilityArtifact {
  if (_cachedArtifact) return _cachedArtifact;

  const entries: AgentCapabilityEntry[] = DEFAULT_AGENT_TARGETS.map((target) => ({
    role: target.role,
    logicalName: target.logicalName,
    runtimeName: target.runtimeName,
    configured: true,
    spawnable: true,
    tools: [],
  }));

  const canonicalContent = JSON.stringify(
    entries.map((e) => ({
      role: e.role,
      logicalName: e.logicalName,
      runtimeName: e.runtimeName,
      configured: e.configured,
      spawnable: e.spawnable,
      source: e.source,
      tools: e.tools,
      unavailableReason: e.unavailableReason,
    })),
    null,
    2,
  );

  const artifactHash = createHash("sha256").update(canonicalContent, "utf-8").digest("hex");

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    artifactHash,
    entries,
  };
}

// ── Persisted copy ───────────────────────────────────────────────────

export function persistCapabilityArtifact(
  cwd: string,
  artifact: AgentCapabilityArtifact,
): string {
  const dir = path.join(
    cwd,
    ".phenix-agent-state",
    "runtime",
    "agent-capabilities",
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const filePath = path.join(dir, `${artifact.artifactHash}.json`);
  fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });

  return filePath;
}
