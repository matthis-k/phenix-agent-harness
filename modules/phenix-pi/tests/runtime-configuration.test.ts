import assert from "node:assert/strict";
import test from "node:test";

import type { AnyDefinition } from "../domain/definition/definition.ts";
import type { DefinitionId } from "../domain/shared.ts";
import { defineRuntimeConfiguration } from "../framework/runtime-configuration.ts";
import { phenixRuntimeConfiguration } from "../suite/phenix-runtime-configuration.ts";

const TEST_ID = "agent.test" as DefinitionId;
const TEST_DEFINITION = { id: TEST_ID } as unknown as AnyDefinition;

function configuration(root: readonly DefinitionId[], hidden: readonly DefinitionId[] = []) {
  return {
    catalog: {
      definitions: [TEST_DEFINITION],
      registerWorkflowFunctions: () => undefined,
      resolveDefinitionSchema: () => {
        throw new Error("not used");
      },
      rootInvokableDefinitions: root,
      hiddenDefinitions: hidden,
    },
    createModelResolver: () => ({
      resolve: async () => {
        throw new Error("not used");
      },
    }),
  };
}

test("accepts the concrete Phenix runtime suite", () => {
  assert.ok(phenixRuntimeConfiguration.catalog.definitions.length > 0);
  assert.ok(phenixRuntimeConfiguration.catalog.rootInvokableDefinitions.length > 0);
});

test("rejects references to definitions absent from the configured catalog", () => {
  assert.throws(
    () => defineRuntimeConfiguration(configuration(["agent.missing" as DefinitionId])),
    /Unknown root-invokable definition/,
  );
});

test("requires hidden definitions to be root-invokable", () => {
  assert.throws(
    () => defineRuntimeConfiguration(configuration([], [TEST_ID])),
    /Hidden definition must also be root-invokable/,
  );
});
