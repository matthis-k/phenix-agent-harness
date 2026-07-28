import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createObservableChildSessionManager } from "../adapters/pi-sdk/agent-session-backend.ts";
import { agentDefinitions } from "../definitions/agents.ts";

test("memory-recovery agents still receive native Pi transcript files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "phenix-child-session-"));

  try {
    const scout = agentDefinitions.find((definition) => definition.id === "agent.scout");
    assert.ok(scout);
    assert.equal(scout.persistence, "memory");

    const sessionDir = join(directory, "sessions");
    const manager = createObservableChildSessionManager(directory, sessionDir);
    assert.equal(manager.isPersisted(), true);
    assert.equal(manager.getSessionDir(), sessionDir);
    assert.match(manager.getSessionFile() ?? "", /\.jsonl$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
