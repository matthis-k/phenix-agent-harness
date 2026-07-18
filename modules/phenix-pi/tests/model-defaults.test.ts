import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  mergeModelDefaults,
  mergeModelDefaultsFile,
} from "../runtime/merge-model-defaults.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultsPath = path.join(packageRoot, "config", "models.json");

async function readDefaults(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(defaultsPath, "utf8")) as Record<string, unknown>;
}

describe("managed model defaults", () => {
  it("forces documented Go protocols while preserving unrelated user config", async () => {
    const current = {
      providers: {
        "opencode-go": {
          apiKey: "$OPENCODE_GO_API_KEY",
          models: [
            {
              id: "minimax-m2.7",
              api: "openai-completions",
              baseUrl: "https://stale.invalid/v1",
              headers: { "x-user-option": "preserved" },
            },
            { id: "deepseek-v4-flash", name: "User alias" },
          ],
        },
        local: {
          baseUrl: "http://127.0.0.1:8080/v1",
          models: [{ id: "local-model" }],
        },
      },
      customSetting: true,
    };

    const merged = mergeModelDefaults(current, await readDefaults()) as typeof current;
    const go = merged.providers["opencode-go"];
    const minimax = go.models.find((model) => model.id === "minimax-m2.7");
    const qwen = go.models.find((model) => model.id === "qwen3.6-plus");

    assert.equal(go.apiKey, "$OPENCODE_GO_API_KEY");
    assert.deepEqual(merged.providers.local, current.providers.local);
    assert.equal(merged.customSetting, true);
    assert.equal(minimax?.api, "anthropic-messages");
    assert.equal(minimax?.baseUrl, "https://opencode.ai/zen/go");
    assert.deepEqual(minimax?.headers, { "x-user-option": "preserved" });
    assert.equal(qwen?.api, "anthropic-messages");
    assert.equal(qwen?.baseUrl, "https://opencode.ai/zen/go");
    assert.equal(go.models.find((model) => model.id === "deepseek-v4-flash")?.name, "User alias");
  });

  it("writes atomically with private permissions and becomes idempotent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-model-defaults-"));
    const targetPath = path.join(directory, "models.json");

    assert.equal(await mergeModelDefaultsFile(defaultsPath, targetPath), true);
    assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
    assert.equal(await mergeModelDefaultsFile(defaultsPath, targetPath), false);

    const rendered = JSON.parse(await readFile(targetPath, "utf8")) as {
      providers: { "opencode-go": { models: Array<{ id: string; api: string }> } };
    };
    const models = rendered.providers["opencode-go"].models;
    assert.deepEqual(
      models.map(({ id, api }) => ({ id, api })),
      [
        { id: "minimax-m2.7", api: "anthropic-messages" },
        { id: "qwen3.6-plus", api: "anthropic-messages" },
      ],
    );
  });
});
