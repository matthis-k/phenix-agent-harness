import assert from "node:assert/strict";
import test from "node:test";

import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { SessionInvocationPolicy } from "../application/invocation-policy.ts";
import { SessionProfileFacadeImpl } from "../application/session-profile-facade.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { WORKFLOW_IMPLEMENT, WORKFLOW_QA } from "../definitions/ids.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { assessExecutionRisk, assessRootMutation } from "../domain/definition/execution-risk.ts";
import { createTestRuntime } from "./support/core-runtime.ts";

function definitionCatalog(): DefinitionCatalog {
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);
  const catalog = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions]) catalog.register(definition);
  catalog.seal(functions, {
    has: (operation) => operation === "local.noop" || operation === "local.qa-checks",
    async run() {
      return undefined;
    },
  });
  return catalog;
}

test("free model blocks sensitive mutation workflows but permits read-only QA", async () => {
  const runtime = await createTestRuntime();
  const profiles = new SessionProfileFacadeImpl(runtime.store);
  await profiles.select(runtime.rootRunId, { modelSet: "free", source: "user" });
  const catalog = definitionCatalog();
  const policy = new SessionInvocationPolicy({ store: runtime.store, catalog });
  const root = runtime.store.projection.requireRun(runtime.rootRunId);

  assert.throws(
    () =>
      policy.assertAllowed({
        rootRunId: runtime.rootRunId,
        parent: root,
        definition: catalog.require(WORKFLOW_IMPLEMENT),
        input: {
          objective: "Rotate production credentials and deploy to main",
          context: { secrecy: "secret", targetState: "main-bound" },
        },
      }),
    /phenix\/free may not execute sensitive mutation/,
  );

  assert.doesNotThrow(() =>
    policy.assertAllowed({
      rootRunId: runtime.rootRunId,
      parent: root,
      definition: catalog.require(WORKFLOW_QA),
      input: { objective: "Audit authentication boundaries without changing files" },
    }),
  );

  assert.doesNotThrow(() =>
    policy.assertAllowed({
      rootRunId: runtime.rootRunId,
      parent: root,
      definition: catalog.require(WORKFLOW_IMPLEMENT),
      input: { objective: "Rename a local documentation heading" },
    }),
  );
});

test("risk classifier recognizes explicit metadata, paths, and commands", () => {
  const explicit = assessExecutionRisk({
    objective: "change configuration",
    context: { changeKind: "auth", targetState: "main-bound" },
  });
  assert.equal(explicit.sensitive, true);
  assert.ok(explicit.reasons.some((reason) => reason.includes("changeKind=auth")));

  const mutation = assessRootMutation({
    userText: "Update production authentication",
    toolName: "bash",
    toolInput: { command: "git push origin main" },
  });
  assert.equal(mutation.sensitive, true);
  assert.ok(mutation.reasons.some((reason) => reason.includes("sensitive command")));
});
