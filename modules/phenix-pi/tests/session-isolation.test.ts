import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  registerSession,
  unregisterSession,
  getSessionCapabilityArtifact,
  getSessionWorkflowData,
  activeSessionCount,
  clearAllSessions,
  type SessionWorkflowData,
} from "../extensions/phenix-workflow/session-registry.ts";

import type { AgentCapabilityArtifact } from "../extensions/phenix-workflow/agent-capabilities.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

const SAMPLE_ARTIFACT: AgentCapabilityArtifact = {
  version: 1,
  generatedAt: new Date().toISOString(),
  artifactHash: "aa".repeat(32),
  entries: [
    { role: "scout", logicalName: "scout", runtimeName: "phenix.scout", configured: true, spawnable: true, tools: [] },
    { role: "planner", logicalName: "planner", runtimeName: "phenix.planner", configured: true, spawnable: true, tools: [] },
    { role: "implementer", logicalName: "implementer", runtimeName: "phenix.implementer", configured: true, spawnable: true, tools: [] },
    { role: "critic", logicalName: "critic", runtimeName: "phenix.critic", configured: true, spawnable: true, tools: [] },
    { role: null, logicalName: "base", runtimeName: "phenix.base", configured: true, spawnable: true, tools: [] },
  ],
};

const SAMPLE_WF_DATA: SessionWorkflowData = {
  instanceId: "inst-1",
  actorId: "root-actor",
  definitionId: "phenix-default",
  definitionVersion: 1,
};

// ── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(() => {
  clearAllSessions();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Session Registry", () => {
  it("registers and retrieves session with capability artifact", () => {
    registerSession("s1", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: SAMPLE_WF_DATA,
    });

    const artifact = getSessionCapabilityArtifact("s1");
    assert.ok(artifact);
    assert.equal(artifact.artifactHash, "aa".repeat(32));

    const wfData = getSessionWorkflowData("s1");
    assert.ok(wfData);
    assert.equal(wfData.instanceId, "inst-1");
  });

  it("returns undefined for unknown session", () => {
    assert.equal(getSessionCapabilityArtifact("nonexistent"), undefined);
    assert.equal(getSessionWorkflowData("nonexistent"), undefined);
  });

  it("unregistered session is no longer retrievable", () => {
    registerSession("s2", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: SAMPLE_WF_DATA,
    });
    unregisterSession("s2");

    assert.equal(getSessionCapabilityArtifact("s2"), undefined);
    assert.equal(getSessionWorkflowData("s2"), undefined);
  });

  it("multiple sessions are isolated", () => {
    registerSession("sA", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: { ...SAMPLE_WF_DATA, instanceId: "inst-A" },
    });
    registerSession("sB", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: { ...SAMPLE_WF_DATA, instanceId: "inst-B" },
    });

    const a = getSessionWorkflowData("sA");
    const b = getSessionWorkflowData("sB");
    assert.ok(a);
    assert.ok(b);
    assert.notEqual(a.instanceId, b.instanceId);

    // Capability artifacts should be independently retrievable.
    assert.ok(getSessionCapabilityArtifact("sA"));
    assert.ok(getSessionCapabilityArtifact("sB"));
  });

  it("unregister is idempotent (no-op for unknown session)", () => {
    assert.doesNotThrow(() => unregisterSession("nonexistent"));
  });

  it("activeSessionCount reflects registered sessions", () => {
    assert.equal(activeSessionCount(), 0);

    registerSession("count1", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: SAMPLE_WF_DATA,
    });
    assert.equal(activeSessionCount(), 1);

    registerSession("count2", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: SAMPLE_WF_DATA,
    });
    assert.equal(activeSessionCount(), 2);

    unregisterSession("count1");
    assert.equal(activeSessionCount(), 1);

    unregisterSession("count2");
    assert.equal(activeSessionCount(), 0);
  });

  it("capability artifact preserves null role (base agent)", () => {
    registerSession("s-base", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: SAMPLE_WF_DATA,
    });
    const artifact = getSessionCapabilityArtifact("s-base");
    assert.ok(artifact);

    const baseEntry = artifact.entries.find((e) => e.role === null);
    assert.ok(baseEntry);
    assert.equal(baseEntry.runtimeName, "phenix.base");

    unregisterSession("s-base");
  });

  it("clearAllSessions removes all entries", () => {
    registerSession("c1", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: SAMPLE_WF_DATA,
    });
    registerSession("c2", {
      capabilityArtifact: SAMPLE_ARTIFACT,
      workflowData: SAMPLE_WF_DATA,
    });

    clearAllSessions();
    assert.equal(activeSessionCount(), 0);
    assert.equal(getSessionCapabilityArtifact("c1"), undefined);
    assert.equal(getSessionCapabilityArtifact("c2"), undefined);
  });
});
