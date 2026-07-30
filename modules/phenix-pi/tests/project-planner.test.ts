import assert from "node:assert/strict";
import test from "node:test";

import { ProjectPlannerService } from "../application/project-planner.ts";
import {
  decisionId,
  type ProjectActor,
  type ProjectEvent,
  type ProjectId,
  type UnsequencedProjectEvent,
} from "../domain/project/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { IdGenerator } from "../ports/clock.ts";
import type { ProjectLedger } from "../ports/project-ledger.ts";

const ROOT = "root-project" as RunId;
const CHILD = "run-decision" as RunId;
const ROOT_ACTOR: ProjectActor = { rootRunId: ROOT, runId: ROOT, sessionId: "root-session" };
const CHILD_ACTOR: ProjectActor = { rootRunId: ROOT, runId: CHILD, sessionId: "child-session" };

class Ids implements IdGenerator {
  private value = 0;

  next(prefix: string): string {
    this.value += 1;
    return `${prefix}-${this.value}`;
  }
}

class MemoryProjectLedger implements ProjectLedger {
  readonly events = new Map<ProjectId, ProjectEvent[]>();

  async list(): Promise<readonly ProjectId[]> {
    return [...this.events.keys()];
  }

  async load(projectId: ProjectId): Promise<readonly ProjectEvent[]> {
    return this.events.get(projectId) ?? [];
  }

  async append(
    projectId: ProjectId,
    expectedRevision: number,
    events: readonly UnsequencedProjectEvent[],
  ): Promise<readonly ProjectEvent[]> {
    const current = this.events.get(projectId) ?? [];
    assert.equal(current.length, expectedRevision);
    const committed = events.map((event, index) => ({
      ...event,
      revision: expectedRevision + index + 1,
    }));
    this.events.set(projectId, [...current, ...committed]);
    return committed;
  }
}

test("a project survives sessions and advances only its unblocked decision frontier", async () => {
  const ledger = new MemoryProjectLedger();
  const notices: string[] = [];
  const deliveries: Array<{ readonly runId: RunId; readonly message: string }> = [];
  const service = new ProjectPlannerService(
    ledger,
    new Ids(),
    { now: () => "2026-07-30T12:00:00.000Z" },
    undefined,
    (message) => notices.push(message),
    async (runId, message) => {
      deliveries.push({ runId, message });
    },
  );
  const foundation = decisionId("decision-foundation");
  const implementation = decisionId("decision-implementation");
  const created = await service.create(
    {
      title: "Cross-session planner",
      destination: {
        outcome: "A reviewed implementation specification",
        useCase: "Agents implement a large project without rediscovering prior decisions",
        doneWhen: ["All blocking design decisions are resolved"],
        nonGoals: ["Implementing the destination during charting"],
      },
      fog: ["Deployment policy after the persistence model is known"],
      decisions: [
        {
          id: foundation,
          title: "Choose the persistence model",
          question: "Which artifact is canonical across sessions?",
          type: "grilling",
          mode: "hitl",
        },
        {
          id: implementation,
          title: "Define the execution frontier",
          question: "How are implementation sessions selected?",
          type: "research",
          mode: "afk",
          dependsOn: [foundation],
        },
      ],
    },
    ROOT_ACTOR,
  );

  assert.deepEqual(
    (await service.frontier(created.id)).map((item) => item.id),
    [foundation],
  );
  await service.claim(created.id, foundation, CHILD_ACTOR);
  const intervention = await service.requestInput(
    created.id,
    foundation,
    {
      question: "Should GitHub issues or the local ledger be canonical?",
      context: "The answer determines offline behavior.",
      options: ["Local ledger", "GitHub"],
    },
    CHILD_ACTOR,
  );
  assert.match(notices[0] ?? "", /needs input/);

  const answered = await service.answerInput(
    created.id,
    intervention.id,
    "The local append-only ledger is canonical; GitHub is a projection.",
    ROOT_ACTOR,
  );
  assert.equal(answered.delivered, true);
  assert.equal(deliveries[0]?.runId, CHILD);

  await service.resolve(
    created.id,
    foundation,
    {
      summary: "Use a local append-only project ledger as the source of truth.",
      rationale: "It remains available offline and cannot drift with tracker presentation.",
      evidence: ["The run ledger already uses append-only JSONL."],
      consequences: ["GitHub synchronization is reconstructable and retryable."],
    },
    CHILD_ACTOR,
  );
  assert.deepEqual(
    (await service.frontier(created.id)).map((item) => item.id),
    [implementation],
  );

  const nextSession = new ProjectPlannerService(ledger, new Ids(), {
    now: () => "2026-07-31T12:00:00.000Z",
  });
  const restored = await nextSession.inspect(created.id);
  assert.equal(restored.decisions[0]?.resolution?.actor.runId, CHILD);
  assert.match(await nextSession.exportSpec(created.id), /Provenance: run run-decision/);
});
