import assert from "node:assert/strict";
import test from "node:test";

import { formatIntegrationReport, summarizeIntegrations } from "../adapters/pi-sdk/integrations.ts";
import {
  completePhenixSubcommands,
  PHENIX_FACTS_USAGE,
  PHENIX_SUBCOMMANDS,
  PHENIX_USAGE,
} from "../extension/phenix-command.ts";

test("phenix command completion lists and filters subcommands", () => {
  assert.deepEqual(
    completePhenixSubcommands("")?.map((item) => item.value),
    PHENIX_SUBCOMMANDS.map((item) => item.value),
  );
  assert.deepEqual(completePhenixSubcommands("I"), [
    { value: "integrations", label: "integrations — Show integration health" },
  ]);
  assert.equal(completePhenixSubcommands("unknown"), null);
  assert.equal(completePhenixSubcommands("status extra"), null);
  assert.equal(PHENIX_USAGE, "/phenix status|runs|facts|tasks|catalog|integrations");
  assert.equal(
    PHENIX_FACTS_USAGE,
    "/phenix facts [off|--once|--json|--clipboard [command]|--file <file>]",
  );
});

test("integration reports are compact in status and detailed on demand", () => {
  const statuses = [
    { id: "hypa", state: "loaded" },
    { id: "lsp", state: "loaded" },
    { id: "mcp", state: "failed", error: "connection\nrefused" },
  ] as const;

  assert.equal(summarizeIntegrations(statuses), "2/3 loaded; failed: mcp");
  assert.equal(
    formatIntegrationReport(statuses),
    [
      "Integrations: 2/3 loaded",
      "✓ Hypa (hypa) — loaded",
      "✓ Language servers (lsp) — loaded",
      "✗ MCP adapter (mcp) — failed",
      "  connection refused",
    ].join("\n"),
  );
});
