import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

import { RpcJsonlPeer } from "../packages/phenix-suite/runtime/rpc-jsonl-peer.ts";

describe("packaged Pi RPC transport", () => {
  it("starts the installed Pi CLI and answers get_state", { timeout: 20_000 }, async () => {
    const command = process.env.PHENIX_PI_BINARY?.trim() || "pi";
    const child = spawn(
      command,
      [
        "--mode",
        "rpc",
        "--approve",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" } },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const peer = new RpcJsonlPeer(child.stdout, child.stdin);
    try {
      const state = await peer.command<{ sessionId: string }>(
        { type: "get_state" },
        { timeoutMs: 10_000 },
      );
      assert.equal(typeof state.data?.sessionId, "string", stderr);
    } finally {
      peer.dispose();
      child.kill("SIGTERM");
    }
  });
});
