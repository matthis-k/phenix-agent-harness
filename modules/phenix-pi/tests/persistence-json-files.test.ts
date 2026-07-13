import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  atomicWriteJson,
  readDirectory,
  readJsonFile,
  sanitizePathSegment,
} from "../extensions/phenix-persistence/json-files.ts";
import { decodeHandleRecord } from "../extensions/phenix-subagents/handle-store.ts";
import {
  decodeWorkflowRecord,
  WorkflowStoreError,
} from "../extensions/phenix-workflow/workflow-store.ts";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "phenix-persistence-"));
}

describe("shared JSON persistence mechanics", () => {
  it("writes atomically and decodes through the caller-owned codec", () => {
    const directory = temporaryDirectory();
    const target = path.join(directory, "nested", "record.json");

    atomicWriteJson(target, { version: 1, value: "stored" });

    const decoded = readJsonFile(target, (value) => {
      assert.equal(typeof value, "object");
      assert.ok(value);
      const record = value as Record<string, unknown>;
      assert.equal(record.version, 1);
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
  it("rejects unsupported handle envelopes before runtime use", () => {
    assert.throws(() => decodeHandleRecord({ version: 3, id: "old" }), /unsupported version/);
  });

  it("reports malformed workflow envelopes with a domain error", () => {
    assert.throws(
      () => decodeWorkflowRecord({ version: 1 }),
      (error: unknown) => error instanceof WorkflowStoreError && error.code === "INVALID_RECORD",
    );
  });
});
