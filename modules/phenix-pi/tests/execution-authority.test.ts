import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createExecutionAuthority,
  InMemoryExecutionAuthorityStore,
} from "../packages/phenix-suite/authority/index.ts";

function createAuthority() {
  return createExecutionAuthority({
    store: new InMemoryExecutionAuthorityStore(),
    maximumDelegationDepth: 2,
    maximumActiveChildren: 2,
  });
}

function mutation(key: string, actorId = "root", expectedRevision?: number) {
  return {
    idempotencyKey: key,
    actorId,
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
}

describe("ExecutionAuthority", () => {
  it("keeps one active objective per root session and makes begin idempotent", () => {
    const authority = createAuthority();
    const input = {
      rootSessionId: "session-1",
      rootActorId: "root",
      userTask: "Implement the requested change",
      workflowDefinitionId: "phenix-implement",
      difficulty: "D2",
      assurance: "A2" as const,
    };
    const first = authority.beginObjective(input, mutation("begin-1"));
    const replay = authority.beginObjective(input, mutation("begin-1"));
    assert.deepEqual(replay, first);
    assert.throws(
      () => authority.beginObjective({ ...input, userTask: "Another task" }, mutation("begin-2")),
      /already owns active objective/,
    );
  });

  it("rejects stale revisions and conflicting idempotency reuse", () => {
    const authority = createAuthority();
    const objective = authority.beginObjective(
      {
        rootSessionId: "session-1",
        rootActorId: "root",
        userTask: "Inspect the repository",
        workflowDefinitionId: "phenix-general",
        difficulty: "D1",
        assurance: "A1",
      },
      mutation("begin"),
    );
    assert.throws(
      () => authority.pauseObjective(objective.id, mutation("pause", "root", 0)),
      /Stale objective revision/,
    );
    authority.pauseObjective(objective.id, mutation("pause", "root", 1));
    assert.throws(
      () => authority.amendObjective(objective.id, "Different input", mutation("pause", "root")),
      /Idempotency key pause was reused/,
    );
  });

  it("separates runtime settlement from acceptance", () => {
    const authority = createAuthority();
    const objective = authority.beginObjective(
      {
        rootSessionId: "session-1",
        rootActorId: "root",
        userTask: "Implement and verify a feature",
        workflowDefinitionId: "phenix-implement",
        difficulty: "D2",
        assurance: "A2",
      },
      mutation("begin"),
    );
    const node = authority.createNode(
      {
        objectiveId: objective.id,
        purpose: "implement",
        assignment: "Implement the feature",
        outputSchemaId: "implementation-handoff",
        role: "implementer",
      },
      mutation("node", "root", objective.revision),
    );
    const afterNode = authority.inspectObjective(objective.id).objective;
    authority.registerHandle(
      {
        id: "handle-1",
        objectiveId: objective.id,
        nodeId: node.id,
        mode: "await",
      },
      mutation("handle", "root", afterNode.revision),
    );
    const afterHandle = authority.inspectObjective(objective.id).objective;
    authority.updateHandleRuntime(
      "handle-1",
      { runtimeState: "running", childRunId: "run-1", piSessionId: "pi-1" },
      mutation("run", "supervisor", afterHandle.revision),
    );
    const afterRun = authority.inspectObjective(objective.id).objective;
    authority.submitResult(
      "handle-1",
      { summary: "implemented" },
      mutation("submit", "implementer", afterRun.revision),
    );
    const submitted = authority.inspectObjective(objective.id);
    assert.equal(submitted.handles[0]?.runtimeState, "settled");
    assert.equal(submitted.handles[0]?.acceptanceState, "submitted");
    assert.equal(submitted.nodes.find((candidate) => candidate.id === node.id)?.state, "submitted");

    authority.beginVerification(
      "handle-1",
      mutation("verify", "authority", submitted.objective.revision),
    );
    const verifying = authority.inspectObjective(objective.id);
    authority.decideAcceptance(
      "handle-1",
      { outcome: "accepted", verificationEvidence: { checks: ["test: passed"] } },
      mutation("accept", "verifier", verifying.objective.revision),
    );
    const accepted = authority.inspectObjective(objective.id);
    assert.equal(accepted.handles[0]?.acceptanceState, "accepted");
    assert.equal(accepted.nodes.find((candidate) => candidate.id === node.id)?.state, "accepted");
  });

  it("supports cursor-based events and durable active-count projection", () => {
    const authority = createAuthority();
    const activeCounts: number[] = [];
    authority.subscribeActiveCount((count) => activeCounts.push(count));
    const objective = authority.beginObjective(
      {
        rootSessionId: "session-1",
        rootActorId: "root",
        userTask: "Run background analysis",
        workflowDefinitionId: "phenix-general",
        difficulty: "D2",
        assurance: "A2",
      },
      mutation("begin"),
    );
    const node = authority.createNode(
      {
        objectiveId: objective.id,
        purpose: "analysis",
        assignment: "Analyze independently",
        outputSchemaId: "base-handoff",
      },
      mutation("node", "root", objective.revision),
    );
    const revision = authority.inspectObjective(objective.id).objective.revision;
    authority.registerHandle(
      { id: "background-1", objectiveId: objective.id, nodeId: node.id, mode: "background" },
      mutation("handle", "root", revision),
    );
    assert.equal(authority.activeCount, 1);
    const events = authority.eventsAfter(0, objective.id);
    assert.ok(events.length >= 3);
    assert.deepEqual(activeCounts, [1]);
  });

  it("revokes descendants and leaves a terminal snapshot on discard", () => {
    const authority = createAuthority();
    const objective = authority.beginObjective(
      {
        rootSessionId: "session-1",
        rootActorId: "root",
        userTask: "Run managed work",
        workflowDefinitionId: "phenix-general",
        difficulty: "D1",
        assurance: "A1",
      },
      mutation("begin"),
    );
    const node = authority.createNode(
      {
        objectiveId: objective.id,
        purpose: "execute",
        assignment: "Perform work",
        outputSchemaId: "base-handoff",
      },
      mutation("node", "root", objective.revision),
    );
    const revision = authority.inspectObjective(objective.id).objective.revision;
    authority.registerHandle(
      { id: "handle", objectiveId: objective.id, nodeId: node.id, mode: "background" },
      mutation("handle", "root", revision),
    );
    const beforeDiscard = authority.inspectObjective(objective.id).objective;
    authority.discardObjective(
      objective.id,
      "discarded by user",
      mutation("discard", "root", beforeDiscard.revision),
    );
    const snapshot = authority.inspectObjective(objective.id);
    assert.equal(snapshot.objective.state, "discarded");
    assert.equal(snapshot.handles[0]?.runtimeState, "cancelled");
    assert.equal(snapshot.handles[0]?.acceptanceState, "cancelled");
    assert.deepEqual(snapshot.legalActions, []);
  });
});
