import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createPhenixExtensionConfiguration,
  installPhenixExtensionSuite,
  type PhenixExtensionConfiguration,
} from "../suite/phenix-extension-suite.ts";

function recordingConfiguration(installed: string[]): PhenixExtensionConfiguration {
  const registrar = (id: string) => () => {
    installed.push(id);
  };
  return createPhenixExtensionConfiguration({
    theme: registrar("theme"),
    userForms: registrar("user-forms"),
    runtime: registrar("runtime"),
    memory: registrar("memory"),
    workspaceStatus: registrar("workspace-status"),
    workspace: registrar("workspace"),
    resultDisplay: registrar("result-display"),
    visualizationDisplay: registrar("visualization-display"),
  });
}

test("installs input interception before runtime input accounting", async () => {
  const installed: string[] = [];
  await installPhenixExtensionSuite({} as ExtensionAPI, recordingConfiguration(installed));
  assert.deepEqual(installed, [
    "theme",
    "user-forms",
    "runtime",
    "memory",
    "workspace-status",
    "workspace",
    "result-display",
    "visualization-display",
  ]);
});

test("keeps complex integration configuration injectable", async () => {
  const installed: string[] = [];
  const integration = {
    prefix: "custom",
    enabled: new Set(["theme", "runtime"]),
  };
  const configured = createPhenixExtensionConfiguration({
    theme: () => {
      if (integration.enabled.has("theme")) installed.push(`${integration.prefix}:theme`);
    },
    userForms: () => undefined,
    runtime: () => {
      if (integration.enabled.has("runtime")) installed.push(`${integration.prefix}:runtime`);
    },
    memory: () => undefined,
    workspaceStatus: () => undefined,
    workspace: () => undefined,
    resultDisplay: () => undefined,
    visualizationDisplay: () => undefined,
  });

  await installPhenixExtensionSuite({} as ExtensionAPI, configured);
  assert.deepEqual(installed, ["custom:theme", "custom:runtime"]);
});
