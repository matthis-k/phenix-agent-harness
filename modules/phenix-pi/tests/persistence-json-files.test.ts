import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { decodeWorkflowRecord, WorkflowStoreError } from "@matthis-k/phenix-flow/workflow-store.ts";
import {
  atomicWriteJson,
  readDirectory,
  readJsonFile,
  sanitizePathSegment,
} from "@matthis-k/phenix-suite/persistence/json-files.ts";
import { decodeHandleRecord } from "@matthis-k/phenix-suite/subagents/handle-store.ts";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phenix-persistence-"));
}

describe("shared JSON persistence mechanics", () => {
  it("writes atomically and decodes through the caller-owned codec", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "nested", "record.json");

    atomicWriteJson(target, { marker: 1, value: "stored" });

    const decoded = readJsonFile(target, (value) => {
      assert.equal(typeof value, "object");
      assert.ok(value);
      const record = value as Record<string, unknown>;
      assert.equal(record.marker, 1);
      assert.equal(typeof record.value, "string");
      return record.value as string;
    });

    assert.equal(decoded, "stored");
    assert.deepEqual(
      fs.readdirSync(path.dirname(target)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );
  });

  it("returns undefined only for missing files", () => {
    const directory = temporaryDirectory();
    const missing = path.join(directory, "missing.json");

    assert.equal(
      readJsonFile(missing, (value) => value),
      undefined,
    );

    const malformed = path.join(directory, "malformed.json");
    fs.writeFileSync(malformed, "{not-json", "utf-8");
    assert.throws(() => readJsonFile(malformed, (value) => value), SyntaxError);
  });

  it("treats a missing directory as empty but surfaces non-directory errors", () => {
    const directory = temporaryDirectory();
    assert.deepEqual(readDirectory(path.join(directory, "missing")), []);

    const file = path.join(directory, "file");
    fs.writeFileSync(file, "content", "utf-8");
    assert.throws(() => readDirectory(file));
  });

  it("sanitizes one path segment without producing an empty name", () => {
    assert.equal(sanitizePathSegment(" session / child "), "session-child");
    assert.equal(sanitizePathSegment("///"), "unknown");
  });
});

describe("domain persistence codecs", () => {
  it("rejects malformed handle records before runtime use", () => {
    assert.throws(() => decodeHandleRecord({ id: "incomplete" }), /malformed/);
  });

  it("reports malformed workflow envelopes with a domain error", () => {
    assert.throws(
      () => decodeWorkflowRecord({ instanceId: "incomplete" }),
      (error: unknown) => error instanceof WorkflowStoreError && error.code === "INVALID_RECORD",
    );
  });
});
