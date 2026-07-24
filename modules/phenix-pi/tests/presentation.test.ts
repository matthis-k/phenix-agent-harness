import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPresentationNotice,
  isPresentationFact,
  PresentationRequestSchema,
  presentationFact,
  presentationFingerprint,
} from "../application/presentation.ts";
import type { RunId } from "../domain/shared.ts";

const sourceRunId = "run-security-review" as RunId;
const request = {
  severity: "high" as const,
  title: "Unsafe command execution",
  summary:
    "A user-controlled command crosses the shell boundary without an explicit operator choice.",
  subject: "modules/phenix-pi/extension/fact-export.ts",
  evidence: ["The command is passed to a shell interpreter."],
};

test("presentation requests are bounded structured data", () => {
  assert.equal(PresentationRequestSchema.validate(request).ok, true);
  assert.equal(PresentationRequestSchema.validate({ ...request, severity: "info" }).ok, false);
  assert.equal(
    PresentationRequestSchema.validate({ ...request, summary: "x".repeat(2_001) }).ok,
    false,
  );
  assert.equal(
    PresentationRequestSchema.validate({ ...request, evidence: Array(9).fill("evidence") }).ok,
    false,
  );
});

test("presentation facts are durable, detectable, and directly renderable", () => {
  const fact = presentationFact(sourceRunId, request);
  assert.equal(isPresentationFact(fact), true);
  assert.equal(fact.kind, "finding-reported");
  assert.equal(fact.source, "agent-report");
  assert.equal(fact.details?.severity, "high");
  assert.match(String(fact.details?.presentationId), /^presentation-[a-f0-9]{16}$/);

  assert.equal(
    formatPresentationNotice(sourceRunId, fact),
    [
      "[HIGH] Unsafe command execution",
      "A user-controlled command crosses the shell boundary without an explicit operator choice.",
      "Subject: modules/phenix-pi/extension/fact-export.ts",
      "Evidence: The command is passed to a shell interpreter.",
      "Source run: run-security-review",
      `Presentation: ${String(fact.details?.presentationId)}`,
    ].join("\n"),
  );
});

test("presentation fingerprints provide deterministic deduplication", () => {
  assert.equal(
    presentationFingerprint(sourceRunId, request),
    presentationFingerprint(sourceRunId, { ...request }),
  );
  assert.notEqual(
    presentationFingerprint(sourceRunId, request),
    presentationFingerprint(sourceRunId, {
      ...request,
      summary: `${request.summary} Additional detail.`,
    }),
  );
});
