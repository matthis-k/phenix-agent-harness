import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readExecutionEvents } from "../packages/phenix-suite/authority/events.ts";
import {
  createExecutionAuthority,
  InMemoryExecutionAuthorityStore,
} from "../packages/phenix-suite/authority/index.ts";

describe("execution event cursor", () => {
  it("resumes after the last delivered sequence", () => {
    const authority = createExecutionAuthority({ store: new InMemoryExecutionAuthorityStore() });
    const objective = authority.beginObjective(
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
    const first = readExecutionEvents(authority, { sequence: 0, objectiveId: objective.id });
    assert.ok(first.events.length > 0);
    const second = readExecutionEvents(authority, first.nextCursor);
    assert.deepEqual(second.events, []);
    assert.deepEqual(second.nextCursor, first.nextCursor);
  });
});
