import assert from "node:assert/strict";
import test from "node:test";

import type { AnyDefinition } from "../domain/definition/definition.ts";
import { definitionId, type DefinitionId } from "../domain/shared.ts";
import { defineRuntimeConfiguration } from "../framework/runtime-configuration.ts";
import { passthroughBudgetPolicy } from "../ports/budget-policy.ts";
import { phenixRuntimeConfiguration } from "../suite/phenix-runtime-configuration.ts";

const TEST_ID = definitionId("agent.test");
const MISSING_ID = definitionId("agent.missing");
const TEST_DEFINITION = { id: TEST_ID } as unknown as AnyDefinition;

function configuration(
  definitionIds: readonly DefinitionId[],
  root: readonly DefinitionId[],
  hidden: readonly DefinitionId[] = [],
  definitions: readonly AnyDefinition[] = [TEST_DEFINITION],
) {
  return {
    budgetPolicy: passthroughBudgetPolicy,
    catalog: {
      definitionIds,
      definitions,
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
  assert.ok(phenixRuntimeConfiguration.catalog.definitionIds.length > 0);
  assert.equal(
    phenixRuntimeConfiguration.catalog.definitions.length,
    phenixRuntimeConfiguration.catalog.definitionIds.length,
  );
  assert.ok(phenixRuntimeConfiguration.catalog.rootInvokableDefinitions.length > 0);
});

test("rejects compiled definitions absent from the declared internal universe", () => {
  assert.throws(
    () => defineRuntimeConfiguration(configuration([MISSING_ID], [], [], [TEST_DEFINITION])),
    /Compiled runtime definition is not declared/,
  );
});

test("rejects declared definitions that were not compiled", () => {
  assert.throws(
    () => defineRuntimeConfiguration(configuration([TEST_ID, MISSING_ID], [])),
    /Declared runtime definition was not compiled: agent.missing/,
  );
});

test("rejects duplicate definition declarations", () => {
  assert.throws(
    () => defineRuntimeConfiguration(configuration([TEST_ID, TEST_ID], [])),
    /Duplicate runtime definition declaration/,
  );
});

test("rejects references outside the declared internal universe", () => {
  assert.throws(
    () => defineRuntimeConfiguration(configuration([TEST_ID], [MISSING_ID])),
    /Unknown root-invokable definition/,
  );
});

test("requires hidden definitions to be root-invokable", () => {
  assert.throws(
    () => defineRuntimeConfiguration(configuration([TEST_ID], [], [TEST_ID])),
    /Hidden definition must also be root-invokable/,
  );
});
