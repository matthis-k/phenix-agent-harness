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
      events: { emit: () => undefined, on: () => undefined },
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
    const beforeStart = handlers.get("before_agent_start");
    const shutdown = handlers.get("session_shutdown");
    assert.ok(start);
    assert.ok(beforeStart);
    assert.ok(shutdown);

    const first = context(directory, "session-one");
    await start({}, first);
    const prompt = (await beforeStart({ systemPrompt: "base" }, first)) as {
      systemPrompt: string;
    };
    assert.match(prompt.systemPrompt, /phenix_dispatch with mode=auto/);
    assert.match(prompt.systemPrompt, /Objectives are durable outcomes/);
    assert.doesNotMatch(prompt.systemPrompt, /phenix_dispatch with mode=qa/);
    const objectiveTool = tools.get("phenix_objectives");
    assert.ok(objectiveTool);
    assert.equal(tools.has("phenix_tasks"), false);
    assert.ok(tools.has("phenix_dispatch"));
    assert.equal(tools.has("phenix_run"), false);
    const firstResult = await objectiveTool.execute(
      "call-1",
      { action: "add", title: "First session objective" },
      new AbortController().signal,
    );
    assert.equal(objectiveRootId(firstResult.details), "root-session-one");
    await shutdown({}, first);

    const second = context(directory, "session-two");
    await start({}, second);
    const secondResult = await objectiveTool.execute(
      "call-2",
      { action: "tree" },
      new AbortController().signal,
    );
    assert.deepEqual(objectiveRoots(secondResult.details), []);
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

function objectiveRootId(details: unknown): string | undefined {
  return (details as { rootRunId?: string } | undefined)?.rootRunId;
}

function objectiveRoots(details: unknown): readonly unknown[] | undefined {
  return (details as { roots?: readonly unknown[] } | undefined)?.roots;
}
