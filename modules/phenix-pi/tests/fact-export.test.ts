import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  copyFactHistory,
  DEFAULT_CLIPBOARD_COMMAND,
  parseFactsCommand,
  writeFactHistory,
} from "../extension/fact-export.ts";

test("fact export command parsing preserves commands and file names", () => {
  assert.deepEqual(parseFactsCommand(""), { kind: "live" });
  assert.deepEqual(parseFactsCommand("off"), { kind: "off" });
  assert.deepEqual(parseFactsCommand("--once"), { kind: "once" });
  assert.deepEqual(parseFactsCommand("--json"), { kind: "json" });
  assert.deepEqual(parseFactsCommand("--clipboard"), {
    kind: "clipboard",
    command: DEFAULT_CLIPBOARD_COMMAND,
  });
  assert.deepEqual(parseFactsCommand("--clipboard wl-copy --type text/plain"), {
    kind: "clipboard",
    command: "wl-copy --type text/plain",
  });
  assert.deepEqual(parseFactsCommand('--file "reports/fact history.txt"'), {
    kind: "file",
    file: "reports/fact history.txt",
  });
  assert.equal(parseFactsCommand("--file"), undefined);
  assert.equal(parseFactsCommand("--unknown"), undefined);
});

test("fact exports write and pipe the complete text", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-facts-"));
  const text = "Phenix fact history · seq 4\n00:00:01 ✓ run-1 · first\n00:00:02 ✓ run-1 · second\n";
  try {
    const file = await writeFactHistory(text, "nested/facts.txt", directory);
    assert.equal(await readFile(file, "utf8"), text);

    const clipboardFile = path.join(directory, "clipboard.txt");
    await copyFactHistory(text, `cat > ${clipboardFile}`, directory);
    assert.equal(await readFile(clipboardFile, "utf8"), text);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
