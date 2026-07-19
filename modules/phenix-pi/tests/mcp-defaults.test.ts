import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { mergeMcpDefaults, mergeMcpDefaultsFile } from "../runtime/merge-mcp-defaults.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultsPath = path.join(packageRoot, "config", "mcp.json");

async function readDefaults(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(defaultsPath, "utf8")) as Record<string, unknown>;
}

describe("managed MCP defaults", () => {
  it("adds managed servers while preserving user settings and custom servers", async () => {
    const current = {
      settings: {
        directTools: true,
        idleTimeout: 30,
      },
      mcpServers: {
        stitch: {
          command: "stale-stitch-mcp",
          debug: true,
        },
        "qt-docs": {
          url: "https://stale.invalid/mcp",
          headers: { "x-user-header": "preserved" },
        },
        custom: {
          command: "custom-mcp",
          args: ["--stdio"],
        },
      },
      customSetting: true,
    };

    const merged = mergeMcpDefaults(current, await readDefaults()) as typeof current & {
      mcpServers: typeof current.mcpServers & {
        nixos: { command: string; lifecycle: string };
        context7: { url: string; lifecycle: string };
      };
    };

    assert.equal(merged.settings.directTools, true);
    assert.equal(merged.settings.idleTimeout, 30);
    assert.equal(merged.customSetting, true);
    assert.deepEqual(merged.mcpServers.custom, current.mcpServers.custom);
    assert.equal(merged.mcpServers.stitch.command, "stitch-mcp");
    assert.equal(merged.mcpServers.stitch.debug, true);
    assert.equal(merged.mcpServers.nixos.command, "mcp-nixos");
    assert.equal(merged.mcpServers.nixos.lifecycle, "lazy");
    assert.equal(merged.mcpServers["qt-docs"].url, "https://qt-docs-mcp.qt.io/mcp");
    assert.deepEqual(merged.mcpServers["qt-docs"].headers, {
      "x-user-header": "preserved",
    });
    assert.equal(merged.mcpServers.context7.url, "https://mcp.context7.com/mcp");
  });

  it("writes atomically with private permissions and becomes idempotent", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-mcp-defaults-"));
    const targetPath = path.join(directory, "mcp.json");
    await writeFile(
      targetPath,
      `${JSON.stringify({ mcpServers: { custom: { command: "custom-mcp" } } }, null, 2)}\n`,
      { mode: 0o600 },
    );

    assert.equal(await mergeMcpDefaultsFile(defaultsPath, targetPath), true);
    assert.equal((await stat(targetPath)).mode & 0o777, 0o600);
    assert.equal(await mergeMcpDefaultsFile(defaultsPath, targetPath), false);

    const rendered = JSON.parse(await readFile(targetPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    assert.ok(rendered.mcpServers.custom);
    assert.ok(rendered.mcpServers.stitch);
    assert.ok(rendered.mcpServers.nixos);
    assert.ok(rendered.mcpServers["qt-docs"]);
    assert.ok(rendered.mcpServers.context7);
  });
});
