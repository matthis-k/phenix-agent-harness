import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  syncOpenCodeAuth,
  syncOpenCodeAuthFile,
} from "../runtime/sync-opencode-auth.mjs";

const zenCredential = { type: "api_key", key: "zen-key" };
const goCredential = { type: "api_key", key: "go-key" };

describe("OpenCode provider authentication aliases", () => {
  it("makes an OpenCode Go login available to the Zen provider", () => {
    const synced = syncOpenCodeAuth({ "opencode-go": goCredential });

    assert.deepEqual(synced, {
      opencode: goCredential,
      "opencode-go": goCredential,
    });
    assert.notEqual(synced.opencode, synced["opencode-go"]);
  });

  it("makes an OpenCode Zen login available to the Go provider", () => {
    const synced = syncOpenCodeAuth({ opencode: zenCredential });

    assert.deepEqual(synced, {
      opencode: zenCredential,
      "opencode-go": zenCredential,
    });
  });

  it("never overwrites explicit provider-specific credentials", () => {
    const current = {
      opencode: zenCredential,
      "opencode-go": goCredential,
    };

    assert.deepEqual(syncOpenCodeAuth(current), current);
  });

  it("does not copy malformed or non-api-key credentials", () => {
    assert.deepEqual(syncOpenCodeAuth({ "opencode-go": { type: "oauth", token: "x" } }), {
      "opencode-go": { type: "oauth", token: "x" },
    });
  });

  it("updates auth.json atomically with private permissions", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-opencode-auth-"));
    const authPath = path.join(directory, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ "opencode-go": goCredential })}\n`, {
      mode: 0o644,
    });

    assert.equal(await syncOpenCodeAuthFile(authPath), true);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
      opencode: goCredential,
      "opencode-go": goCredential,
    });
    assert.equal(await syncOpenCodeAuthFile(authPath), false);
  });

  it("leaves a missing auth file untouched", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-opencode-auth-missing-"));
    assert.equal(await syncOpenCodeAuthFile(path.join(directory, "auth.json")), false);
  });
});
