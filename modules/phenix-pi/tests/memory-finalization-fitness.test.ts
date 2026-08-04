import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const REPOSITORY_ROOT = new URL("../../../", import.meta.url);

async function source(path: string): Promise<string> {
  return readFile(new URL(path, ROOT), "utf8");
}

test("keeps recoverable ledger damage read-only until explicit repair", async () => {
  const repository = await source("adapters/persistence/jsonl-memory-repository.ts");
  assert.match(repository, /writable: stateValue === "healthy"/);
  assert.match(repository, /requires repair before evidence can be appended/);
  assert.match(repository, /requires repair before notes can be appended/);
});

test("bounds every model-facing inventory response", async () => {
  const extension = await source("adapters/pi-sdk/memory-session-extension.ts");
  assert.match(extension, /snapshot\.notes\.slice\(0, 20\)/);
  assert.match(extension, /snapshot\.evidence\.slice\(0, 20\)/);
  assert.match(extension, /health\.issues\.slice\(0, 50\)/);
  assert.match(extension, /maximumReadBytes/);
});

test("includes derived retrieval and typed telemetry without a second durable authority", async () => {
  const service = await source("application/memory-service.ts");
  const index = await source("application/memory-search-index.ts");
  assert.match(service, /new MemorySearchIndex\(persisted\.notes\)/);
  assert.match(service, /telemetry: this\.telemetry\(rootRunId\)/);
  assert.match(service, /recordContextAssembly/);
  assert.doesNotMatch(index, /node:fs|writeFile|appendFile|Jsonl/);
});

test("does not ship one-shot integration machinery", async () => {
  const temporaryPaths = [
    ".github/workflows/integrate-production-memory.yml",
    ".github/workflows/integrate-production-memory-v2.yml",
    ".github/workflows/integrate-production-memory-v3.yml",
    ".github/workflows/integrate-production-memory-pr.yml",
    ".github/scripts/add_memory_snapshot_telemetry.py",
    ".github/scripts/integrate_memory_index_telemetry.py",
    ".github/scripts/fix_memory_static_invariants.py",
    ".github/scripts/fix_memory_interface_bounds.py",
  ];
  for (const path of temporaryPaths) {
    await assert.rejects(access(new URL(path, REPOSITORY_ROOT)));
  }
});
