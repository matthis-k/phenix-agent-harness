import assert from "node:assert/strict";
import test from "node:test";
import type { HeadlessCommand } from "../headless/protocol.ts";
import {
  HeadlessCommandError,
  type HeadlessCommandExecutor,
  HeadlessProtocolServer,
} from "../headless/server.ts";

test("headless server correlates concurrent responses and serializes complete frames", async () => {
  const writes: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const executor = executorFrom(async (command) => {
    if (command.type === "snapshot.request") {
      await first;
      return { kind: "snapshot" };
    }
    return { kind: command.type };
  });
  const server = new HeadlessProtocolServer({
    executor,
    write: (line) => {
      writes.push(line);
    },
  });

  const acceptance = server.accept(
    `${request("slow", { type: "snapshot.request" })}${request("fast", { type: "model.list" })}`,
  );
  await nextTurn();
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0] ?? "null").id, "fast");

  releaseFirst?.();
  await acceptance;
  assert.equal(writes.length, 2);
  assert.equal(JSON.parse(writes[1] ?? "null").id, "slow");
});

test("duplicate in-flight request IDs are rejected without a second execution", async () => {
  const writes: string[] = [];
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let executions = 0;
  const server = new HeadlessProtocolServer({
    executor: executorFrom(async () => {
      executions += 1;
      await pending;
      return { kind: "done" };
    }),
    write: (line) => {
      writes.push(line);
    },
  });

  const acceptance = server.accept(
    `${request("same", { type: "snapshot.request" })}${request("same", { type: "model.list" })}`,
  );
  await nextTurn();
  assert.equal(executions, 1);
  const duplicate = JSON.parse(writes[0] ?? "null") as {
    result?: { ok?: boolean; error?: { code?: string } };
  };
  assert.equal(duplicate.result?.ok, false);
  assert.equal(duplicate.result?.error?.code, "invalid_state");

  release?.();
  await acceptance;
});

test("invalid frames become protocol events instead of crashing the server", async () => {
  const writes: string[] = [];
  const server = new HeadlessProtocolServer({
    executor: executorFrom(async () => undefined),
    write: (line) => {
      writes.push(line);
    },
  });

  await server.accept(`not-json\n`);
  const frame = JSON.parse(writes[0] ?? "null") as {
    kind?: string;
    event?: { type?: string; error?: { code?: string } };
  };
  assert.equal(frame.kind, "event");
  assert.equal(frame.event?.type, "protocol.error");
  assert.equal(frame.event?.error?.code, "invalid_frame");
});

test("secret command values are never reflected in failure responses", async () => {
  const writes: string[] = [];
  const server = new HeadlessProtocolServer({
    executor: executorFrom(async () => {
      throw new HeadlessCommandError({
        code: "invalid_state",
        message: "Authentication flow is not awaiting input",
      });
    }),
    write: (line) => {
      writes.push(line);
    },
  });

  await server.accept(
    request("auth", {
      type: "auth.login.respond",
      flowId: "flow-1",
      response: { kind: "secret", value: "super-secret-value" },
    }),
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.includes("super-secret-value"), false);
});

function executorFrom(
  execute: (command: HeadlessCommand) => Promise<unknown>,
): HeadlessCommandExecutor {
  return {
    execute,
    dispose: async () => undefined,
  };
}

function request(id: string, command: HeadlessCommand): string {
  return `${JSON.stringify({ kind: "request", id, command })}\n`;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
