import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { RpcJsonlPeer } from "../packages/phenix-suite/runtime/rpc-jsonl-peer.ts";

function pair() {
  const fromPi = new PassThrough();
  const toPi = new PassThrough();
  const peer = new RpcJsonlPeer(fromPi, toPi);
  let writes = "";
  toPi.setEncoding("utf8");
  toPi.on("data", (chunk) => {
    writes += String(chunk);
  });
  return { fromPi, peer, readWrites: () => writes };
}

describe("RpcJsonlPeer", () => {
  it("correlates fragmented strict-LF responses", async () => {
    const { fromPi, peer, readWrites } = pair();
    const result = peer.command<{ sessionId: string }>({ type: "get_state" });
    await new Promise((resolve) => setImmediate(resolve));
    const request = JSON.parse(readWrites().trim()) as { id: string };
    const response = JSON.stringify({
      id: request.id,
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "session-1" },
    });
    fromPi.write(response.slice(0, 12));
    fromPi.write(`${response.slice(12)}\r\n`);
    assert.equal((await result).data?.sessionId, "session-1");
    peer.dispose();
  });

  it("delivers asynchronous events without consuming pending commands", async () => {
    const { fromPi, peer, readWrites } = pair();
    const events: unknown[] = [];
    peer.subscribe((event) => events.push(event));
    const result = peer.command({ type: "prompt", message: "hello" });
    await new Promise((resolve) => setImmediate(resolve));
    const request = JSON.parse(readWrites().trim()) as { id: string };
    fromPi.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    fromPi.write(
      `${JSON.stringify({ id: request.id, type: "response", command: "prompt", success: true })}\n`,
    );
    await result;
    assert.deepEqual(events, [{ type: "agent_start" }]);
    peer.dispose();
  });

  it("rejects pending commands on malformed protocol data", async () => {
    const { fromPi, peer } = pair();
    const result = peer.command({ type: "get_state" });
    fromPi.write("{bad json}\n");
    await assert.rejects(result, /malformed JSONL/);
    peer.dispose();
  });

  it("rejects an unterminated record at EOF", async () => {
    const { fromPi, peer } = pair();
    const result = peer.command({ type: "get_state" });
    fromPi.end('{"type":"agent_start"}');
    await assert.rejects(result, /unterminated JSON record/);
    peer.dispose();
  });
});
