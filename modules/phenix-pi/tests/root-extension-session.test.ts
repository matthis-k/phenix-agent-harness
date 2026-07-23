import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import phenixRootExtension from "../extension/root-extension.ts";

type Handler = (event: unknown, context: ExtensionContext) => unknown;

interface RegisteredTool {
  readonly name: string;
  execute(
    toolCallId: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ readonly details?: unknown }>;
}

test("registered root tools follow the active Pi session runtime", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-extension-"));
  try {
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, RegisteredTool>();
    const fakePi = {
      events: { emit: () => undefined },
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerProvider: () => undefined,
      registerTool(tool: unknown) {
        const registered = tool as RegisteredTool;
        tools.set(registered.name, registered);
      },
      getAllTools: () => [...tools.values()],
      setActiveTools: () => undefined,
      setThinkingLevel: () => undefined,
      setModel: async () => true,
      registerCommand: () => undefined,
      appendEntry: () => undefined,
      sendMessage: () => undefined,
    } as unknown as ExtensionAPI;
    await phenixRootExtension(fakePi);

    const start = handlers.get("session_start");
    const shutdown = handlers.get("session_shutdown");
    assert.ok(start);
    assert.ok(shutdown);

    const first = context(directory, "session-one");
    await start({}, first);
    const taskTool = tools.get("phenix_tasks");
    assert.ok(taskTool);
    const firstResult = await taskTool.execute(
      "call-1",
      { action: "tree" },
      new AbortController().signal,
    );
    assert.equal(rootId(firstResult.details), "root-session-one");
    await shutdown({}, first);

    const second = context(directory, "session-two");
    await start({}, second);
    const secondResult = await taskTool.execute(
      "call-2",
      { action: "tree" },
      new AbortController().signal,
    );
    assert.equal(rootId(secondResult.details), "root-session-two");
    await shutdown({}, second);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function context(cwd: string, sessionId: string): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
      getBranch: () => [],
    },
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      getRegisteredProviderIds: () => [],
      getRegisteredProviderConfig: () => undefined,
    },
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
  } as unknown as ExtensionContext;
}

function rootId(details: unknown): string | undefined {
  return (details as { root?: { runId?: string } } | undefined)?.root?.runId;
}
