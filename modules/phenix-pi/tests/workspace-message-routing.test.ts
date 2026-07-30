import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectPlannerFacade } from "../application/project-planner.ts";
import { projectWorkspaceAttention } from "../application/workspace/project-attention.ts";
import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import {
  decisionId,
  interventionId,
  type ProjectIntervention,
  type ProjectMap,
  projectId,
} from "../domain/project/model.ts";
import type { RunId } from "../domain/shared.ts";
import { routeWorkspaceMessage } from "../extension/workspace/workspace-message-routing.ts";

const ROOT = "root-workspace" as RunId;
const CHILD = "run-child" as RunId;

function project(interventions: readonly ProjectIntervention[]): ProjectMap {
  return {
    id: projectId("project-routing"),
    revision: 1,
    title: "Routing",
    destination: {
      outcome: "Route operator input",
      useCase: "Reply to the selected session",
      doneWhen: ["Replies reach the selected session"],
      nonGoals: [],
    },
    notes: [],
    fog: [],
    decisions: [],
    interventions,
    createdAt: "2026-07-30T12:00:00.000Z",
    updatedAt: "2026-07-30T12:00:00.000Z",
  };
}

function pending(
  id: string,
  urgency: "normal" | "urgent",
  requestedAt: string,
): ProjectIntervention {
  return {
    id: interventionId(id),
    decisionId: decisionId(`decision-${id}`),
    requestedBy: { rootRunId: ROOT, runId: CHILD, sessionId: "child-session" },
    question: `Question ${id}`,
    options: [],
    urgency,
    requestedAt,
    status: "pending",
  };
}

test("workspace messages preserve root input semantics when the root transcript is selected", async () => {
  const rootMessages: string[] = [];
  const runtime = runtimeWith({ projects: [] });
  const route = await routeWorkspaceMessage({
    runtime,
    rootRunId: ROOT,
    targetRunId: ROOT,
    text: "Continue",
    sendRoot: (message) => {
      rootMessages.push(message);
    },
  });

  assert.equal(route.kind, "root");
  assert.deepEqual(rootMessages, ["Continue"]);
  assert.equal(runtime.attentionCalls.length, 0);
});

test("workspace replies answer the newest pending intervention for the selected session", async () => {
  const older = pending("older", "normal", "2026-07-30T12:00:00.000Z");
  const newer = pending("newer", "urgent", "2026-07-30T12:01:00.000Z");
  const runtime = runtimeWith({ projects: [project([older, newer])] });
  const route = await routeWorkspaceMessage({
    runtime,
    rootRunId: ROOT,
    targetRunId: CHILD,
    text: "Use the local ledger.",
    sendRoot: () => {
      throw new Error("Root input must not be used");
    },
  });

  assert.equal(route.kind, "intervention");
  assert.equal(runtime.answered[0]?.interventionId, newer.id);
  assert.equal(runtime.answered[0]?.answer, "Use the local ledger.");
  assert.equal(runtime.attentionCalls.length, 0);
});

test("ordinary selected-session input uses one explicit urgent attention target", async () => {
  const runtime = runtimeWith({ projects: [] });
  const route = await routeWorkspaceMessage({
    runtime,
    rootRunId: ROOT,
    targetRunId: CHILD,
    text: "Check the alternate API.",
    sendRoot: () => {
      throw new Error("Root input must not be used");
    },
  });

  assert.equal(route.kind, "run");
  assert.deepEqual(runtime.attentionCalls[0]?.targetRunIds, [CHILD]);
  assert.equal(runtime.attentionCalls[0]?.message, "Check the alternate API.");
});

test("pending project interventions project visible urgency per session", () => {
  const visible = projectWorkspaceAttention([
    project([
      pending("normal", "normal", "2026-07-30T12:00:00.000Z"),
      pending("urgent", "urgent", "2026-07-30T12:01:00.000Z"),
    ]),
  ]);

  assert.deepEqual(visible[CHILD], {
    kind: "input-required",
    count: 2,
    urgent: true,
  });
});

function runtimeWith(input: { readonly projects: readonly ProjectMap[] }) {
  const attentionCalls: Array<{
    readonly message: string;
    readonly targetRunIds?: readonly RunId[];
  }> = [];
  const answered: Array<{
    readonly interventionId: ProjectIntervention["id"];
    readonly answer: string;
  }> = [];
  const projects = {
    list: async () => input.projects,
    answerInput: async (_projectId, target, answer) => {
      answered.push({ interventionId: target, answer });
      const intervention = input.projects
        .flatMap((candidate) => candidate.interventions)
        .find((candidate) => candidate.id === target);
      if (!intervention) throw new Error(`Unknown intervention ${target}`);
      return { ...intervention, status: "answered" as const, answer, delivered: true };
    },
  } as Pick<ProjectPlannerFacade, "list" | "answerInput">;
  const attention = {
    submit: async (request: {
      readonly message: string;
      readonly targetRunIds?: readonly RunId[];
    }) => {
      attentionCalls.push(request);
      return {
        attentionId: "attention-test" as never,
        routedBy: "explicit" as const,
        targets: [
          {
            runId: request.targetRunIds?.[0] as RunId,
            delivery: "urgent" as const,
            reason: "Explicit operator target",
          },
        ],
        deliveries: [
          {
            runId: request.targetRunIds?.[0] as RunId,
            delivery: "urgent" as const,
            status: "delivered" as const,
          },
        ],
      };
    },
  };
  return Object.assign(
    { projects, attention } as unknown as Pick<PhenixRuntime, "projects" | "attention">,
    { attentionCalls, answered },
  );
}
