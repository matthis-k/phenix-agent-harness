import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createExecutionAuthority,
  InMemoryExecutionAuthorityStore,
} from "../packages/phenix-suite/authority/index.ts";
import { objectiveControl } from "../packages/phenix-suite/authority/objective-control.ts";

describe("objectiveControl", () => {
  it("uses the same revisioned authority operations", () => {
    const authority = createExecutionAuthority({ store: new InMemoryExecutionAuthorityStore() });
    const control = objectiveControl(authority);
    const objective = control.begin(
      {
        rootSessionId: "session",
        rootActorId: "root",
        userTask: "Execute",
        workflowDefinitionId: "phenix-general",
        difficulty: "D1",
        assurance: "A1",
      },
      { idempotencyKey: "begin", actorId: "root" },
    );
    const paused = control.pause(objective.id, {
      idempotencyKey: "pause",
      actorId: "root",
      expectedRevision: objective.revision,
    });
    assert.equal(paused.state, "paused");
    const resumed = control.resume(objective.id, {
      idempotencyKey: "resume",
      actorId: "root",
      expectedRevision: paused.revision,
    });
    assert.equal(resumed.state, "active");
  });
});
