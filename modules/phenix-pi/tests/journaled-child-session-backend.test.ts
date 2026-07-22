import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  clearSessionExecutionJournalRegistry,
  sessionExecutionJournalForProject,
} from "@matthis-k/phenix-suite/journal/session-execution-journal-registry.ts";
import {
  type ChildCycleOutcome,
  type ChildRun,
  type ChildSessionBackend,
  type ChildSessionEvent,
  type ChildSessionNode,
  type ChildSessionSpec,
  childRunId,
} from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import { createJournaledChildSessionBackend } from "@matthis-k/phenix-suite/runtime/journaled-child-session-backend.ts";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "phenix-child-journal-"));
  mkdirSync(join(root, ".git"));
  return root;
}

class FakeRun implements ChildRun {
  readonly backend = "sdk" as const;
  readonly pi: ChildRun["pi"];
  readonly id: ChildRun["id"];

  private readonly listeners = new Set<(event: ChildSessionEvent) => void>();
  private status: ChildSessionNode["status"] = "running";

  constructor(id: ChildRun["id"], sessionId: string) {
    this.id = id;
    this.pi = { sessionId };
  }

  emit(event: ChildSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  snapshot(): ChildSessionNode {
    return {
      id: this.id,
      rootId: this.id,
      handleId: `handle-${this.id}`,
      role: "base",
      agentClient: "phenix.base" as ChildSessionNode["agentClient"],
      model: { provider: "test", id: "model" },
      thinkingLevel: "low",
      contractId: `contract-${this.id}`,
      backend: this.backend,
      pi: this.pi,
      status: this.status,
      startedAt: "2026-07-22T00:00:00.000Z",
    };
  }

  subscribe(listener: (event: ChildSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async continue(): Promise<ChildCycleOutcome> {
    this.emit({ type: "tool.started", runId: this.id, toolName: "read" });
    this.emit({
      type: "tool.completed",
      runId: this.id,
      toolName: "read",
      isError: false,
    });
    this.emit({ type: "cycle.settled", runId: this.id, cycle: 1 });
    return { cycle: 1, status: "settled", lastAssistantText: "handoff complete" };
  }

  waitForCurrentCycle(): Promise<ChildCycleOutcome> {
    return Promise.resolve({ cycle: 1, status: "settled", lastAssistantText: "handoff complete" });
  }

  async abort(reason: string): Promise<void> {
    this.status = "cancelled";
    this.emit({ type: "session.cancelled", runId: this.id, reason });
  }

  async dispose(): Promise<void> {
    this.status = "disposed";
    this.emit({ type: "session.disposed", runId: this.id });
  }
}

class FakeBackend implements ChildSessionBackend {
  readonly kind = "sdk" as const;
  readonly runs = new Map<string, FakeRun>();

  start(spec: ChildSessionSpec): Promise<ChildRun> {
    const run = new FakeRun(spec.id, `pi-${spec.id}`);
    this.runs.set(spec.id, run);
    return Promise.resolve(run);
  }
}

function spec(input: {
  readonly cwd: string;
  readonly id: string;
  readonly actorId: string;
  readonly parentActorId: string;
  readonly parentId?: string;
}): ChildSessionSpec {
  const id = childRunId(input.id);
  return {
    id,
    ...(input.parentId ? { parentId: childRunId(input.parentId) } : {}),
    rootId: childRunId("producer"),
    handleId: `handle-${input.id}`,
    cwd: input.cwd,
    role: "base",
    model: { provider: "test", id: "model" },
    assurance: "A1",
    isolationRequired: false,
    initialPrompt: `Perform ${input.id}`,
    parentContext: { sessionId: "root-session" },
    contract: {
      assignment: { requirements: ["report results"] },
      runtime: {
        workflow: {
          instanceId: "objective-1",
          actorId: input.actorId,
          parentActorId: input.parentActorId,
        },
      },
    },
  } as unknown as ChildSessionSpec;
}

describe("journaled child session backend", () => {
  it("records root, child, and grandchild interactions in one ordered journal", async () => {
    const root = project();
    const fake = new FakeBackend();
    const backend = createJournaledChildSessionBackend(fake);
    const signal = new AbortController().signal;

    try {
      clearSessionExecutionJournalRegistry();
      const producer = await backend.start(
        spec({
          cwd: root,
          id: "producer",
          actorId: "actor-producer",
          parentActorId: "root",
        }),
        signal,
      );
      const tester = await backend.start(
        spec({
          cwd: root,
          id: "tester",
          actorId: "actor-tester",
          parentActorId: "actor-producer",
          parentId: "producer",
        }),
        signal,
      );

      await tester.continue("Run the deterministic checks.");
      await tester.waitForCurrentCycle();

      const events = sessionExecutionJournalForProject(root, "root-session").readAll();
      assert.ok(events.length >= 8);
      assert.deepEqual(
        events.map((event) => event.sequence),
        events.map((_, index) => index + 1),
      );
      assert.ok(events.every((event) => event.rootSessionId === "root-session"));

      const producerStarted = events.find(
        (event) => event.type === "child.session.started" && event.childRunId === "producer",
      );
      assert.equal(producerStarted?.parentSessionId, "root-session");

      const testerStarted = events.find(
        (event) => event.type === "child.session.started" && event.childRunId === "tester",
      );
      assert.equal(testerStarted?.parentSessionId, "pi-producer");

      assert.ok(
        events.some(
          (event) =>
            event.type === "interaction.parent_to_child" &&
            event.sessionId === "pi-producer" &&
            event.childRunId === "tester",
        ),
      );
      assert.ok(
        events.some(
          (event) => event.type === "child.tool.started" && event.sessionId === "pi-tester",
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.type === "interaction.child_to_parent" && event.sessionId === "pi-tester",
        ),
      );

      await tester.dispose();
      await producer.dispose();
    } finally {
      clearSessionExecutionJournalRegistry();
      rmSync(root, { recursive: true });
    }
  });
});
