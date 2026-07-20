import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createTaskRuntimeFacade,
  startTaskRpcServer,
  type TaskRuntimeFacade,
  taskClientFromEnvironment,
  taskProcessEnvironment,
} from "@matthis-k/phenix-tasks/index.ts";

function createWorkflow(service: TaskRuntimeFacade) {
  return service.ensureWorkflow({
    workflowId: "wf_test",
    ownerSessionId: "root-session",
    rootActorId: "root-actor",
    title: "Implement task tracking",
  });
}

describe("phenix-tasks facade", () => {
  it("derives parent WIP state and hides storage records behind task DTOs", () => {
    const service = createTaskRuntimeFacade();
    const root = createWorkflow(service);
    const phase = service.add(root.token, { name: "Implement service", description: "Core tree" });
    const child = service.add(root.token, { parentUid: phase.uid, name: "Ownership checks" });

    service.update(root.token, { uid: child.uid, status: "wip" });
    let tree = service.inspect(root.token);
    assert.equal(tree.children[0]?.status, "wip");
    assert.equal(tree.children[0]?.name, "Implement service");

    service.update(root.token, { uid: child.uid, status: "done" });
    service.update(root.token, { uid: phase.uid, status: "done" });
    tree = service.inspect(root.token);
    assert.equal(tree.children[0]?.status, "done");
  });

  it("keeps append-only process updates and resolves exact path or UID", () => {
    const service = createTaskRuntimeFacade();
    const root = createWorkflow(service);
    const phase = service.add(root.token, { name: "Implementation", description: "Wire facade" });
    const child = service.add(root.token, { parentUid: phase.uid, name: "Transport" });

    service.appendLog(root.token, { uid: child.uid, message: "Mapped the RPC operation." });
    service.appendLog(root.token, {
      uid: child.uid,
      message: "Verified process capability checks.",
    });

    const byPath = service.readLog(root.token, "Implementation.Transport");
    const byUid = service.readLog(root.token, child.uid);
    assert.equal(byPath.uid, child.uid);
    assert.deepEqual(
      byUid.log.map((entry) => entry.message),
      ["Mapped the RPC operation.", "Verified process capability checks."],
    );
    assert.ok(
      service
        .references(root.token)
        .some((reference) => reference.path.endsWith("Implementation.Transport")),
    );
  });

  it("limits a claimed child to its delegated subtree, including logs", () => {
    const service = createTaskRuntimeFacade();
    const root = createWorkflow(service);
    service.prepareDelegation(root.token, { task: "Implement transport" });
    const child = service.claimDelegation({
      workflowId: "wf_test",
      parentActorId: "root-actor",
      childActorId: "child-actor",
      childSessionId: "child-session",
      task: "Implement transport",
    });
    const leaf = service.add(child.token, { name: "Socket client" });
    service.appendLog(child.token, { uid: leaf.uid, message: "Connected to the parent socket." });
    assert.throws(
      () => service.appendLog(child.token, { uid: root.scopeTaskId, message: "Invalid" }),
      /outside the actor-owned subtree/,
    );
  });

  it("uses the same facade and log operation across a process boundary", async () => {
    const service = createTaskRuntimeFacade();
    const root = createWorkflow(service);
    const directory = await mkdtemp(path.join(os.tmpdir(), "phenix-tasks-"));
    const server = await startTaskRpcServer({
      service,
      socketPath: path.join(directory, "tasks.sock"),
    });
    try {
      const client = taskClientFromEnvironment(
        taskProcessEnvironment({ endpoint: server.endpoint, authority: root }),
      );
      assert.ok(client);
      const child = await client.add({ name: "Process task", description: "Exercise RPC" });
      await client.appendLog({ uid: child.uid, message: "RPC update received." });
      const completed = await client.update({ uid: child.uid, status: "done" });
      assert.equal(completed.status, "done");
      assert.equal(service.readLog(root.token, child.uid).log[0]?.message, "RPC update received.");
    } finally {
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
