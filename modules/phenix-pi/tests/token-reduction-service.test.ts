import assert from "node:assert/strict";
import test from "node:test";

import { TokenReductionService } from "../application/token-reduction-service.ts";
import { runId } from "../domain/shared.ts";
import type {
  PrepareTokenReductionInput,
  TokenReductionBackend,
} from "../ports/token-reduction-backend.ts";
import type { CaptureReducedToolEvidenceInput } from "../ports/token-reduction-evidence.ts";

class FakeBackend implements TokenReductionBackend {
  readonly id = "fake";
  recovered = "complete raw output";
  prepared?: PrepareTokenReductionInput;
  cleaned: string[] = [];

  async prepare(input: PrepareTokenReductionInput) {
    this.prepared = input;
    return {
      kind: "rewrite" as const,
      backend: this.id,
      originalCommand: input.command,
      command: `fake ${input.command}`,
      recoveryKey: input.toolCallId,
    };
  }

  async recover() {
    return this.recovered ? { content: this.recovered, complete: true } : undefined;
  }

  async cleanup(preparation: { readonly recoveryKey: string }) {
    this.cleaned.push(preparation.recoveryKey);
  }
}

test("captures raw evidence before returning a compact model view", async () => {
  const backend = new FakeBackend();
  const captures: CaptureReducedToolEvidenceInput[] = [];
  const service = new TokenReductionService({
    runId: runId("run-root"),
    cwd: "/workspace",
    backend,
    evidence: {
      async captureToolResult(input) {
        captures.push(input);
        return { id: "evidence-raw" };
      },
    },
  });

  const preparation = await service.prepareBash("call-1", "git status");
  assert.equal(preparation.kind, "rewrite");
  if (preparation.kind !== "rewrite") return;
  assert.equal(preparation.command, "fake git status");

  const result = await service.complete({
    toolName: "bash",
    toolCallId: "call-1",
    input: { command: preparation.command },
    content: [
      { type: "text", text: "compact\n[full output: /tmp/rtk/full.log]" },
    ],
    details: { exitCode: 0 },
    isError: false,
  });

  assert.ok(result);
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0]?.input, { command: "git status" });
  assert.deepEqual(captures[0]?.content, [{ type: "text", text: "complete raw output" }]);
  assert.equal(result.metrics.evidenceId, "evidence-raw");
  assert.equal(result.metrics.lossless, true);
  assert.match(JSON.stringify(result.content), /exact evidence evidence-raw/);
  assert.doesNotMatch(JSON.stringify(result.content), /\/tmp\/rtk/);
  assert.deepEqual(backend.cleaned, ["call-1"]);
});

test("fails open and marks a reduced result non-lossless when recovery is absent", async () => {
  const backend = new FakeBackend();
  backend.recovered = "";
  let captures = 0;
  const service = new TokenReductionService({
    runId: runId("run-root"),
    cwd: "/workspace",
    backend,
    evidence: {
      async captureToolResult() {
        captures += 1;
        return { id: "unexpected" };
      },
    },
  });

  await service.prepareBash("call-2", "cargo test");
  const result = await service.complete({
    toolName: "bash",
    toolCallId: "call-2",
    input: { command: "fake cargo test" },
    content: [{ type: "text", text: "compact failure" }],
    isError: true,
  });

  assert.ok(result);
  assert.equal(captures, 0);
  assert.equal(result.metrics.lossless, false);
  assert.equal(result.metrics.evidenceId, undefined);
  assert.match(JSON.stringify(result.details), /phenixTokenReduction/);
});

test("does nothing when no backend is configured", async () => {
  const service = new TokenReductionService({
    runId: runId("run-root"),
    cwd: "/workspace",
    evidence: {
      async captureToolResult() {
        throw new Error("must not capture");
      },
    },
  });

  assert.deepEqual(await service.prepareBash("call-3", "git status"), {
    kind: "passthrough",
    reason: "disabled",
  });
  assert.equal(
    await service.complete({
      toolName: "bash",
      toolCallId: "call-3",
      input: {},
      content: [],
      isError: false,
    }),
    undefined,
  );
});
