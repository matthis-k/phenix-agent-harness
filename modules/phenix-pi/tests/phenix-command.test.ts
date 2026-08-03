import assert from "node:assert/strict";
import test from "node:test";

import { formatIntegrationReport, summarizeIntegrations } from "../adapters/pi-sdk/integrations.ts";
import {
  completePhenixSubcommands,
  PHENIX_FACTS_USAGE,
  PHENIX_HEALTH_USAGE,
  PHENIX_STATUS_USAGE,
  PHENIX_SUBCOMMANDS,
  PHENIX_UI_USAGE,
  PHENIX_USAGE,
  parsePhenixInvocation,
} from "../extension/phenix-command.ts";

test("phenix command completion lists and filters subcommands", () => {
  assert.deepEqual(
    completePhenixSubcommands("")?.map((item) => item.value),
    PHENIX_SUBCOMMANDS.map((item) => item.value),
  );
  assert.deepEqual(
    PHENIX_SUBCOMMANDS.map((item) => item.value),
    ["ui", "status", "health", "logs", "facts", "objectives", "integrations"],
  );
  assert.deepEqual(completePhenixSubcommands("h"), [
    { value: "health", label: "health — Inspect runtime and configuration health" },
  ]);
  assert.deepEqual(completePhenixSubcommands("I"), [
    { value: "integrations", label: "integrations — Show integration health" },
  ]);
  assert.deepEqual(completePhenixSubcommands("l"), [
    { value: "logs", label: "logs — Inspect or export structured diagnostics" },
  ]);
  assert.deepEqual(completePhenixSubcommands("o"), [
    { value: "objectives", label: "objectives — Show the objective and sub-objective tree" },
  ]);
  assert.equal(completePhenixSubcommands("c"), null);
  assert.equal(completePhenixSubcommands("r"), null);
  assert.equal(completePhenixSubcommands("unknown"), null);
  assert.equal(completePhenixSubcommands("status extra"), null);
  assert.equal(PHENIX_USAGE, "/phenix [ui|status|health|logs|facts|objectives|integrations]");
  assert.equal(PHENIX_UI_USAGE, "/phenix ui [status|runs [run-id]|facts|catalog [definition-id]]");
  assert.equal(PHENIX_STATUS_USAGE, "/phenix status [--json|--expanded]");
  assert.equal(
    PHENIX_HEALTH_USAGE,
    "/phenix health [integrations|models|definitions|runtime|storage] [--json]",
  );
  assert.equal(PHENIX_FACTS_USAGE, "/phenix facts [--json|--clipboard [command]|--file <file>]");
});

test("bare phenix resolves to the UI while known subcommands are parsed", () => {
  assert.deepEqual(parsePhenixInvocation(""), {
    action: "ui",
    rawOptions: "",
    options: [],
    implicitUi: true,
  });
  assert.deepEqual(parsePhenixInvocation(" status --JSON --Expanded "), {
    action: "status",
    rawOptions: "--JSON --Expanded",
    options: ["--json", "--expanded"],
    implicitUi: false,
  });
  assert.deepEqual(parsePhenixInvocation("ui runs run-123"), {
    action: "ui",
    rawOptions: "runs run-123",
    options: ["runs", "run-123"],
    implicitUi: false,
  });
});

test("unknown actions parse to an explicit invalid variant", () => {
  assert.deepEqual(parsePhenixInvocation("wat --JSON"), {
    action: "invalid",
    requestedAction: "wat",
    rawOptions: "--JSON",
    options: ["--json"],
    implicitUi: false,
  });
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
