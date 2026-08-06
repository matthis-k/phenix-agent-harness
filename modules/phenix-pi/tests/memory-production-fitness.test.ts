import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { defaultMemoryPolicy } from "../domain/memory/policy.ts";
import { phenixRuntimeConfiguration } from "../suite/phenix-runtime-configuration.ts";

const ROOT = new URL("../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

test("binds one validated memory policy at the concrete composition root", () => {
  assert.equal(phenixRuntimeConfiguration.memoryPolicy, defaultMemoryPolicy);
  assert.equal(defaultMemoryPolicy.storage.synchronizeWrites, true);
  assert.equal(defaultMemoryPolicy.storage.verifyEvidenceOnRead, true);
  assert.equal(defaultMemoryPolicy.captureFailureMode, "diagnose-and-continue");
});

test("keeps persisted memory behind the audited unknown decoder", async () => {
  const repository = await source("adapters/persistence/jsonl-memory-repository.ts");
  assert.match(repository, /parseMemoryLedgerEntry\(JSON\.parse\(line\) as unknown\)/);
  assert.doesNotMatch(repository, /as MemoryLedgerEntry/);
  assert.match(repository, /notes\.recorded/);
  assert.doesNotMatch(repository, /note\.recorded/);
});

test("keeps context behavior policy-driven and model requests schema-driven", async () => {
  const extension = await source("adapters/pi-sdk/memory-session-extension.ts");
  assert.match(extension, /MEMORY_TOOL_PARAMETERS/);
  assert.match(extension, /parseMemoryToolRequest/);
  assert.match(extension, /memory\.policy\.context/);
  assert.doesNotMatch(extension, /const FOLD_RATIO|const AGGRESSIVE_RATIO/);
});

test("preserves the single persistence authority for indexed retrieval", async () => {
  const service = await source("application/memory-service.ts");
  const index = await source("application/memory-search-index.ts");
  assert.match(service, /new MemorySearchIndex\(persisted\.notes\)/);
  assert.match(service, /state\.searchIndex\.upsert\(note\)/);
  assert.doesNotMatch(index, /writeFile|appendFile|Jsonl/);
});
