import assert from "node:assert/strict";
import test from "node:test";

import {
  HeadlessRuntimeExecutor,
  type HeadlessExecutorDependencies,
} from "../headless/executor.ts";

function dependencies(calls: string[]): HeadlessExecutorDependencies {
  const called = async (name: string, value: unknown = { kind: name }): Promise<unknown> => {
    calls.push(name);
    return value;
  };
  return {
    lifecycle: {
      initialize: async () => called("lifecycle.initialize"),
      shutdown: async () => called("lifecycle.shutdown"),
      dispose: async () => {
        calls.push("lifecycle.dispose");
      },
    },
    execution: {
      snapshot: async () => called("execution.snapshot"),
      submitPrompt: async (command) => called(`execution.prompt:${command.runId}`),
      steerPrompt: async (command) => called(`execution.steer:${command.runId}`),
      followUpPrompt: async (command) => called(`execution.follow_up:${command.runId}`),
      abort: async (command) => called(`execution.abort:${command.runId ?? "active"}`),
      startCompaction: async (command) => called(`execution.compact:${command.runId}`),
      abortCompaction: async (command) => called(`execution.abort_compact:${command.runId}`),
      configureRetry: async (command) => called(`execution.retry:${command.runId}`),
      abortRetry: async (command) => called(`execution.abort_retry:${command.runId}`),
    },
    sessions: {
      create: async () => called("sessions.create"),
      switch: async (command) => called(`sessions.switch:${command.sessionId}`),
      fork: async (command) => called(`sessions.fork:${command.sessionId}:${command.entryId}`),
      clone: async (command) => called(`sessions.clone:${command.sessionId}`),
      rename: async (command) => called(`sessions.rename:${command.sessionId}`),
      list: async () => called("sessions.list"),
      tree: async (command) => called(`sessions.tree:${command.sessionId}`),
      export: async (command) => called(`sessions.export:${command.sessionId}`),
    },
    models: {
      list: async () => called("models.list"),
      select: async (command) => called(`models.select:${command.runId}`),
      thinkingLevels: async (command) => called(`models.thinking:${command.runId}`),
      selectThinking: async (command) => called(`models.select_thinking:${command.runId}`),
    },
    auth: {
      providers: async () => called("auth.providers"),
      start: async () => called("auth.start"),
      respond: async () => called("auth.respond"),
      cancel: async () => called("auth.cancel"),
      logout: async () => called("auth.logout"),
    },
    resources: {
      commands: async () => called("resources.commands"),
      invoke: async (command) => called(`resources.invoke:${command.runId}:${command.name}`),
      reload: async () => called("resources.reload"),
    },
    extensionUi: {
      respond: async (command) => called(`extension_ui.respond:${command.dialogId}`),
    },
  };
}

test("execution and model commands are routed by run identity", async () => {
  const calls: string[] = [];
  const executor = new HeadlessRuntimeExecutor(dependencies(calls));

  await executor.execute({
    type: "prompt.submit",
    runId: "child-run",
    text: "continue",
    images: [],
  });
  await executor.execute({
    type: "model.select",
    runId: "child-run",
    model: { provider: "openai", model: "gpt" },
  });

  assert.deepEqual(calls, ["execution.prompt:child-run", "models.select:child-run"]);
});

test("persisted session commands remain separate from run-targeted commands", async () => {
  const calls: string[] = [];
  const executor = new HeadlessRuntimeExecutor(dependencies(calls));

  await executor.execute({ type: "session.switch", sessionId: "session-file-1" });
  await executor.execute({
    type: "session.fork",
    sessionId: "session-file-1",
    entryId: "entry-4",
  });

  assert.deepEqual(calls, [
    "sessions.switch:session-file-1",
    "sessions.fork:session-file-1:entry-4",
  ]);
});

test("executor owns lifecycle disposal exactly once", async () => {
  const calls: string[] = [];
  const executor = new HeadlessRuntimeExecutor(dependencies(calls));

  await executor.dispose();
  await executor.dispose();
  assert.deepEqual(calls, ["lifecycle.dispose"]);
  await assert.rejects(() => executor.execute({ type: "snapshot.request" }), /disposed/);
});
