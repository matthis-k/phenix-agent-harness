import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  defineExtensionSuite,
  installExtensionSuite,
  orderExtensionModules,
  type ExtensionModule,
} from "../framework/extension-suite.ts";

interface Services {
  readonly record: (value: string) => void;
}

function module(id: string, requires: readonly string[] = []): ExtensionModule<Services> {
  return {
    id,
    requires,
    register: (_pi, services) => services.record(id),
  };
}

test("orders modules by dependencies while preserving declaration order", () => {
  const ordered = orderExtensionModules([
    module("tail", ["runtime"]),
    module("theme"),
    module("runtime", ["theme"]),
    module("independent"),
  ]);
  assert.deepEqual(
    ordered.map((item) => item.id),
    ["theme", "runtime", "tail", "independent"],
  );
});

test("rejects missing and cyclic extension dependencies", () => {
  assert.throws(
    () => orderExtensionModules([module("runtime", ["missing"])]),
    /requires unknown module missing/,
  );
  assert.throws(
    () => orderExtensionModules([module("a", ["b"]), module("b", ["a"])]),
    /Cyclic extension module dependencies/,
  );
});

test("installs modules with injected suite services", async () => {
  const installed: string[] = [];
  const suite = defineExtensionSuite({
    services: { record: (value: string) => installed.push(value) },
    modules: [module("theme"), module("runtime", ["theme"])],
  });
  await installExtensionSuite({} as ExtensionAPI, suite);
  assert.deepEqual(installed, ["theme", "runtime"]);
});
