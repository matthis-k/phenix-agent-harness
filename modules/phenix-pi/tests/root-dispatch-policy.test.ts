import assert from "node:assert/strict";
import test from "node:test";

import { AGENT_BASE, ROOT_DISPATCH_DEFINITION_IDS, WORKFLOW_QA } from "../definitions/ids.ts";
import { definitionRef } from "../domain/definition/definition.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

test("root may invoke dispatch targets but not the general-purpose escape hatch", async () => {
  const runtime = await createTestRuntime(undefined, {
    rootInvokableDefinitions: ROOT_DISPATCH_DEFINITION_IDS,
  });

  await assert.rejects(
    runtime.execution.start({
      parentId: runtime.rootRunId,
      definition: definitionRef(AGENT_BASE),
      input: { objective: "bypass dispatch" },
      wait: "await",
    }),
    /cannot invoke agent\.base/,
  );

  const qa = await runtime.execution.start({
    parentId: runtime.rootRunId,
    definition: definitionRef(WORKFLOW_QA),
    input: { objective: "full repository QA" },
    wait: "await",
  });
  assert.equal((await qa.result()).status, "success");
});
