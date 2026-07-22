import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { RpcJsonlPeer } from "../packages/phenix-suite/runtime/rpc-jsonl-peer.ts";

describe("packaged Pi RPC transport", () => {
  it("starts the installed Pi CLI and answers get_state", { timeout: 20_000 }, async () => {
    const command = process.env.PHENIX_PI_BINARY?.trim() || "pi";
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "phenix-rpc-smoke-"));
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
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
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
        },
      },
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
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
