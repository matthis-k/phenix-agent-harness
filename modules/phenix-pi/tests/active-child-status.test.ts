import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type ActiveSubagentCountSource,
  activeSubsessionStatusText,
  registerActiveChildStatusProjection,
} from "@matthis-k/phenix-suite/runtime/active-child-status.ts";
import type { ActiveSubagentCountListener } from "@matthis-k/phenix-suite/runtime/subagent-manager.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

class RecordingPi {
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async emit(event: string, ctx: ExtensionContext): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({}, ctx);
    }
  }
}

class ActiveCountSource implements ActiveSubagentCountSource {
  activeCount = 0;
  private readonly listeners = new Set<ActiveSubagentCountListener>();

  subscribeActiveCount(listener: ActiveSubagentCountListener): () => void {
    this.listeners.add(listener);
    listener(this.activeCount);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(activeCount: number): void {
    this.activeCount = activeCount;
    for (const listener of [...this.listeners]) listener(activeCount);
  }
}

function context(sessionId: string, statuses: string[]): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      setStatus: (id: string, text: string) => {
        statuses.push(`${id}:${text}`);
      },
    },
  } as unknown as ExtensionContext;
}

describe("active child status projection", () => {
  it("formats active subsession counts", () => {
    assert.equal(activeSubsessionStatusText(0), "Phenix · 0 active subsessions");
    assert.equal(activeSubsessionStatusText(1), "Phenix · 1 active subsession");
    assert.equal(activeSubsessionStatusText(2), "Phenix · 2 active subsessions");
  });

  it("updates the retained root context while children start and terminate", async () => {
    const pi = new RecordingPi();
    const source = new ActiveCountSource();
    const statuses: string[] = [];
    const ctx = context("root-session", statuses);
    const dispose = registerActiveChildStatusProjection({
      pi: pi as unknown as ExtensionAPI,
      source,
    });

    source.set(1);
    assert.deepEqual(statuses, []);

    await pi.emit("session_start", ctx);
    source.set(2);
    source.set(1);
    source.set(0);

    assert.deepEqual(statuses, [
      "phenix:Phenix · 1 active subsession",
      "phenix:Phenix · 2 active subsessions",
      "phenix:Phenix · 1 active subsession",
      "phenix:Phenix · 0 active subsessions",
    ]);

    dispose();
    source.set(1);
    assert.equal(statuses.at(-1), "phenix:Phenix · 0 active subsessions");
  });

  it("refreshes a newly supplied context with the current count", async () => {
    const pi = new RecordingPi();
    const source = new ActiveCountSource();
    source.set(3);
    const statuses: string[] = [];
    const dispose = registerActiveChildStatusProjection({
      pi: pi as unknown as ExtensionAPI,
      source,
    });

    await pi.emit("context", context("root-session", statuses));

    assert.deepEqual(statuses, ["phenix:Phenix · 3 active subsessions"]);
    dispose();
  });
});
