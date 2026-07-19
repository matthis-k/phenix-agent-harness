import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PhenixTaskService,
  startTaskRpcServer,
  TaskRpcClient,
} from "@matthis-k/phenix-tasks/index.ts";

function createWorkflow(service: PhenixTaskService) {
  return service.ensureWorkflow({
    workflowId: "wf_test",
    ownerSessionId: "root-session",
    rootActorId: "root-actor",
    title: "Implement task tracking",
  });
}

describe("phenix-tasks", () => {
  it("derives parent WIP state from active or completed children", () => {
    const service = new PhenixTaskService();
    const root = createWorkflow(service);
    const phase = service.addTask(root.token, { title: "Implement service" });
    const child = service.addTask(root.token, {
      parentId: phase.id,
      title: "Add ownership checks",
    });

    service.updateTask(root.token, { taskId: child.id, state: "wip" });
    let tree = service.inspect(root.token);
    assert.equal(tree.children[0]?.effectiveState, "wip");

    service.updateTask(root.token, { taskId: child.id, state: "done" });
    tree = service.inspect(root.token);
    assert.equal(tree.children[0]?.explicitState, "not_started");
    assert.equal(tree.children[0]?.effectiveState, "wip");

    service.updateTask(root.token, { taskId: phase.id, state: "done" });
    tree = service.inspect(root.token);
    assert.equal(tree.children[0]?.effectiveState, "done");
  });

  it("limits a claimed child authority to its delegated subtree", () => {
    const service = new PhenixTaskService();
    const root = createWorkflow(service);
    service.prepareDelegation(root.token, {
      task: "Implement transport",
      requirements: ["Use an opaque capability"],
    });

    const child = service.claimDelegation({
      workflowId: "wf_test",
      parentActorId: "root-actor",
      childActorId: "child-actor",
      childSessionId: "child-session",
      task: "Implement transport",
      requirements: ["Use an opaque capability"],
    });
    const childTree = service.inspect(child.token);
    assert.equal(childTree.title, "Implement transport");
    assert.equal(childTree.assignedSessionId, "child-session");

    const leaf = service.addTask(child.token, { title: "Add socket client" });
    service.updateTask(child.token, { taskId: leaf.id, state: "done" });
    service.updateTask(child.token, { taskId: child.scopeTaskId, state: "done" });

    assert.throws(
      () => service.updateTask(child.token, { taskId: root.scopeTaskId, state: "done" }),
      /outside the actor-owned subtree/,
    );
  });

  it("rejects completion while child tasks remain unfinished", () => {
    const service = new PhenixTaskService();
    const root = createWorkflow(service);
    const phase = service.addTask(root.token, { title: "Verify" });
    service.addTask(root.token, { parentId: phase.id, title: "Run tests" });

    assert.throws(
      () => service.updateTask(root.token, { taskId: phase.id, state: "done" }),
      /child tasks remain unfinished/,
    );
  });

  it("uses the same capability checks over a Unix socket", async () => {
    const service = new PhenixTaskService();
    const root = createWorkflow(service);
    const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-tasks-"));
    const socketPath = path.join(directory, "tasks.sock");
    const server = await startTaskRpcServer({ service, socketPath });

    try {
      const client = new TaskRpcClient(socketPath, root.token);
      const initial = await client.inspect();
      assert.equal(initial.title, "Implement task tracking");

      const child = await client.add({ title: "Exercise process boundary" });
      const completed = await client.update({ taskId: child.id, state: "done" });
      assert.equal(completed.completedBySessionId, "root-session");
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
