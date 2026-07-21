import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  publishManagedBackgroundSettlement,
} from "@matthis-k/phenix-suite/subagents/background-settlement-channel.ts";
import phenixSubagents from "@matthis-k/phenix-suite/subagents/extension.ts";
import type { PhenixSubagentsOptions } from "@matthis-k/phenix-suite/subagents/registration.ts";

function context(id: string): ExtensionContext {
  return {
    sessionManager: {
      getSessionId: () => id,
    },
  } as unknown as ExtensionContext;
}

describe("background settlement parent notification", () => {
  it("wakes the owning parent session and points it at the exact terminal handle", async () => {
    const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
    const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const pi = {
      on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
        const registered = handlers.get(event) ?? [];
        registered.push(handler);
        handlers.set(event, registered);
      },
      registerTool() {},
      sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
        messages.push({ message, options });
      },
    } as unknown as ExtensionAPI;
    const clearedSessions: string[] = [];
    const options = {
      facade: {
        workflow: {},
      },
      workflowGate: {
        clearSession(id: string) {
          clearedSessions.push(id);
        },
      },
    } as unknown as PhenixSubagentsOptions;

    await phenixSubagents(pi, options);
    const ctx = context("root-session");
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }

    await publishManagedBackgroundSettlement({
      cwd: "/tmp/project",
      sessionId: "root-session",
      record: {
        id: "handle-42",
        sessionId: "root-session",
        modelSet: "mixed",
        assignment: {
          task: "Inspect the workflow return boundary.",
          requirements: [],
          outputSchema: { type: "object" },
        },
        producerSpec: {} as never,
        subagentId: "child-42",
        rootSubagentId: "child-42",
        producerCycles: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "completed",
        value: { summary: "finished" },
      },
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.message.customType, "phenix-background-settled");
    assert.match(String(messages[0]?.message.content), /handle-42/);
    assert.match(String(messages[0]?.message.content), /action=await/);
    assert.deepEqual(messages[0]?.options, {
      deliverAs: "steer",
      triggerTurn: true,
    });

    await publishManagedBackgroundSettlement({
      cwd: "/tmp/project",
      sessionId: "another-session",
      record: {
        id: "foreign-handle",
        sessionId: "another-session",
        modelSet: "mixed",
        assignment: {
          task: "Do not notify this session.",
          requirements: [],
          outputSchema: { type: "object" },
        },
        producerSpec: {} as never,
        producerCycles: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "completed",
      },
    });
    assert.equal(messages.length, 1);

    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({ type: "session_shutdown" }, ctx);
    }
    assert.deepEqual(clearedSessions, ["root-session"]);
  });
});
