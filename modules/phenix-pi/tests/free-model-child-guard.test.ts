import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  blockSensitiveFreeModelMutation,
  freeModelSessionExtensions,
  isFreeTierModel,
  type ToolCallBlock,
} from "../adapters/pi-sdk/free-model-guard.ts";

interface ToolCallEvent {
  readonly toolName: string;
  readonly input: unknown;
}

type ToolCallHandler = (
  event: ToolCallEvent,
  context?: unknown,
) => Promise<ToolCallBlock | undefined> | ToolCallBlock | undefined;

test("managed child sessions receive visualization and free models also receive a guard", () => {
  const freeModel = {
    kind: "concrete" as const,
    provider: "opencode",
    model: "deepseek-v4-flash-free",
  };
  assert.equal(isFreeTierModel(freeModel), true);
  assert.equal(freeModelSessionExtensions(freeModel).length, 2);
  assert.equal(
    isFreeTierModel({
      kind: "concrete",
      provider: "opencode",
      model: "deepseek-v4-flash",
    }),
    false,
  );
  assert.equal(
    freeModelSessionExtensions({
      kind: "concrete",
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    }).length,
    1,
  );
});

test("the inline child guard blocks sensitive bash and nix-shell commands", async () => {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on(event: string, candidate: ToolCallHandler) {
      if (event === "tool_call") handler = candidate;
    },
  } as unknown as ExtensionAPI;
  const [, factory] = freeModelSessionExtensions({
    kind: "concrete",
    provider: "opencode",
    model: "mimo-v2.5-free",
  });
  assert.ok(factory);
  factory(pi);
  assert.ok(handler);

  const bashResult = await handler({
    toolName: "bash",
    input: { command: "git push origin main" },
  });
  assert.equal(bashResult?.block, true);
  assert.match(bashResult?.reason ?? "", /phenix\/free may not perform this sensitive mutation/);

  const nixResult = await handler({
    toolName: "nix_shell",
    input: { packages: ["git"], command: "git", args: ["push", "origin", "main"] },
  });
  assert.equal(nixResult?.block, true);
});

test("free-model mutation assessment is command-local and permits benign tools", () => {
  assert.equal(
    blockSensitiveFreeModelMutation({
      toolName: "bash",
      toolInput: { command: "devenv test" },
    }),
    undefined,
  );
  assert.equal(
    blockSensitiveFreeModelMutation({
      toolName: "read",
      toolInput: { path: ".github/workflows/ci.yml" },
    }),
    undefined,
  );
  assert.equal(
    blockSensitiveFreeModelMutation({
      toolName: "write",
      toolInput: { path: ".github/workflows/ci.yml", content: "name: CI" },
    })?.block,
    true,
  );
});
