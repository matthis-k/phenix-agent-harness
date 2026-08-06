import assert from "node:assert/strict";
import test from "node:test";

import { AgentSessionBackendRouter } from "../framework/routing/agent-session-backend-router.ts";
import type {
  AgentSessionBackend,
  AgentSessionPort,
  AgentSessionReference,
  CreateAgentSessionSpec,
} from "../ports/agent-session-backend.ts";
import { runId } from "../domain/shared.ts";

class RecordingBackend implements AgentSessionBackend {
  readonly created: string[] = [];
  readonly recovered: string[] = [];

  async create(spec: CreateAgentSessionSpec): Promise<AgentSessionPort> {
    this.created.push(spec.runId);
    return {} as AgentSessionPort;
  }

  async recover(
    spec: CreateAgentSessionSpec,
    _reference: AgentSessionReference,
  ): Promise<AgentSessionPort | undefined> {
    this.recovered.push(spec.runId);
    return {} as AgentSessionPort;
  }
}

const spec = {
  runId: runId("run-1"),
  cwd: "/tmp",
  model: { kind: "concrete", provider: "anthropic", model: "sonnet" },
  thinking: "medium",
  systemPrompt: "test",
  tools: [],
  customTools: [],
  context: {
    projectFiles: "none",
    artifacts: [],
    maxBytes: 0,
  },
  persistence: "memory",
} as const satisfies CreateAgentSessionSpec;

test("agent sessions are dispatched to the run's selected backend", async () => {
  const pi = new RecordingBackend();
  const claude = new RecordingBackend();
  const router = new AgentSessionBackendRouter({
    backends: new Map([
      ["pi", pi],
      ["claude", claude],
    ]),
    backendForRun: () => "claude",
  });

  await router.create(spec);
  await router.recover(spec, { sessionId: "session-1" });

  assert.deepEqual(pi.created, []);
  assert.deepEqual(pi.recovered, []);
  assert.deepEqual(claude.created, ["run-1"]);
  assert.deepEqual(claude.recovered, ["run-1"]);
});

test("unregistered backend targets fail before reaching another backend", async () => {
  const pi = new RecordingBackend();
  const router = new AgentSessionBackendRouter({
    backends: new Map([["pi", pi]]),
    backendForRun: () => "claude",
  });

  await assert.rejects(router.create(spec), /unregistered agent-session backend 'claude'/);
  assert.deepEqual(pi.created, []);
});
