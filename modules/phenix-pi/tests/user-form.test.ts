import assert from "node:assert/strict";
import test from "node:test";

import { UserFormService } from "../application/user-form-service.ts";
import { runId } from "../domain/shared.ts";
import type { UserFormDefinition, UserFormRequest } from "../domain/user-form/model.ts";
import { formatUserFormStatus, orderPendingUserForms } from "../extension/user-form-extension.ts";
import { InlineUserFormSession } from "../extension/workspace/inline-user-form-session.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";

const ROOT = runId("root");
const PLANNER = runId("planner");
const IMPLEMENTER = runId("implementer");

class SequenceIds implements IdGenerator {
  private sequence = 0;

  next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

class SequenceClock implements Clock {
  private sequence = 0;

  now(): string {
    this.sequence += 1;
    return `2026-07-31T00:00:0${this.sequence}.000Z`;
  }
}

test("queues concurrent forms and completes each requesting agent independently", async () => {
  const service = new UserFormService(new SequenceIds(), new SequenceClock());
  let changes = 0;
  service.subscribe(() => {
    changes += 1;
  });

  const plannerResult = service.request({
    rootRunId: ROOT,
    requestedByRunId: PLANNER,
    form: form("Plan choices"),
  });
  const implementerResult = service.request({
    rootRunId: ROOT,
    requestedByRunId: IMPLEMENTER,
    urgency: "urgent",
    form: form("Blocked implementation"),
  });

  const queued = service.list(ROOT);
  assert.deepEqual(
    queued.map((request) => [request.form.title, request.urgency]),
    [
      ["Plan choices", "normal"],
      ["Blocked implementation", "urgent"],
    ],
  );
  assert.deepEqual(service.counts(ROOT), { total: 2, urgent: 1 });

  const urgent = queued[1];
  assert.ok(urgent);
  service.complete(urgent.id, {
    status: "submitted",
    answers: [{ questionId: "choice", answer: "B", suggestionValue: "B" }],
  });
  const completedImplementer = await implementerResult;
  assert.equal(completedImplementer.status, "submitted");
  if (completedImplementer.status === "submitted") {
    assert.deepEqual(completedImplementer.answers, [
      { questionId: "choice", answer: "B", suggestionValue: "B" },
    ]);
  }
  assert.deepEqual(service.counts(ROOT), { total: 1, urgent: 0 });

  const remaining = service.list(ROOT)[0];
  assert.ok(remaining);
  service.complete(remaining.id, {
    status: "submitted",
    answers: [{ questionId: "choice", answer: "custom" }],
  });
  const completedPlanner = await plannerResult;
  assert.equal(completedPlanner.status, "submitted");
  assert.deepEqual(service.counts(ROOT), { total: 0, urgent: 0 });
  assert.equal(changes, 4);
});

test("orders urgent forms first while retaining FIFO order within urgency", () => {
  const requests = [
    request("normal-old", "normal", "2026-07-31T00:00:01.000Z"),
    request("urgent-new", "urgent", "2026-07-31T00:00:04.000Z"),
    request("urgent-old", "urgent", "2026-07-31T00:00:02.000Z"),
    request("normal-new", "normal", "2026-07-31T00:00:03.000Z"),
  ];

  assert.deepEqual(
    orderPendingUserForms(requests).map((item) => item.form.title),
    ["urgent-old", "urgent-new", "normal-old", "normal-new"],
  );
  assert.equal(formatUserFormStatus({ total: 0, urgent: 0 }), undefined);
  assert.equal(
    formatUserFormStatus({ total: 2, urgent: 0 }),
    "forms 2 pending · answer in input",
  );
  assert.equal(
    formatUserFormStatus({ total: 3, urgent: 1 }),
    "forms 3 pending · 1 urgent · answer in input",
  );
});

test("default input answers the active inline form and accepts numbered suggestions", async () => {
  const service = new UserFormService(new SequenceIds(), new SequenceClock());
  const result = service.request({
    rootRunId: ROOT,
    requestedByRunId: PLANNER,
    form: {
      title: "Two decisions",
      submitLabel: "Apply",
      questions: [
        {
          id: "choice",
          prompt: "Choose an approach",
          required: true,
          suggestions: [
            { label: "Option A", value: "A" },
            { label: "Option B", value: "B" },
          ],
        },
        {
          id: "detail",
          prompt: "Add detail",
          required: false,
          suggestions: [],
        },
      ],
    },
  });
  const session = new InlineUserFormSession(service, ROOT);

  const first = session.active();
  assert.equal(first?.questionIndex, 0);
  const next = session.answer("2");
  assert.equal(next?.questionIndex, 1);
  assert.deepEqual(next?.answers[0], {
    questionId: "choice",
    answer: "B",
    suggestionValue: "B",
  });
  const completed = session.answer("custom detail");
  assert.equal(completed?.completed, true);

  assert.deepEqual(await result, {
    status: "submitted",
    answers: [
      { questionId: "choice", answer: "B", suggestionValue: "B" },
      { questionId: "detail", answer: "custom detail" },
    ],
    submittedAt: "2026-07-31T00:00:02.000Z",
  });
});

test("an active form remains stable when a later urgent form enters the queue", async () => {
  const service = new UserFormService(new SequenceIds(), new SequenceClock());
  const normalResult = service.request({
    rootRunId: ROOT,
    requestedByRunId: PLANNER,
    form: form("Normal first"),
  });
  const session = new InlineUserFormSession(service, ROOT);
  assert.equal(session.active()?.request.form.title, "Normal first");

  const urgentResult = service.request({
    rootRunId: ROOT,
    requestedByRunId: IMPLEMENTER,
    urgency: "urgent",
    form: form("Urgent later"),
  });
  assert.equal(session.active()?.request.form.title, "Normal first");
  session.answer("A");
  assert.equal((await normalResult).status, "submitted");
  assert.equal(session.active()?.request.form.title, "Urgent later");
  session.cancel();
  assert.equal((await urgentResult).status, "cancelled");
});

test("aborting one requester removes only its pending form", async () => {
  const service = new UserFormService(new SequenceIds(), new SequenceClock());
  const abort = new AbortController();
  const cancelled = service.request(
    {
      rootRunId: ROOT,
      requestedByRunId: PLANNER,
      form: form("Cancelled"),
    },
    abort.signal,
  );
  const retained = service.request({
    rootRunId: ROOT,
    requestedByRunId: IMPLEMENTER,
    form: form("Retained"),
  });

  abort.abort(new Error("requesting run stopped"));
  await assert.rejects(cancelled, /requesting run stopped/);
  assert.deepEqual(
    service.list(ROOT).map((item) => item.form.title),
    ["Retained"],
  );

  const pending = service.list(ROOT)[0];
  assert.ok(pending);
  service.complete(pending.id, { status: "cancelled", reason: "user" });
  assert.equal((await retained).status, "cancelled");
});

function form(title: string): UserFormDefinition {
  return {
    title,
    submitLabel: "Apply",
    questions: [
      {
        id: "choice",
        prompt: "Choose an approach",
        required: true,
        suggestions: [
          { label: "Option A", value: "A" },
          { label: "Option B", value: "B" },
        ],
      },
    ],
  };
}

function request(
  title: string,
  urgency: UserFormRequest["urgency"],
  requestedAt: string,
): UserFormRequest {
  return {
    id: `userform-${title}` as UserFormRequest["id"],
    rootRunId: ROOT,
    requestedByRunId: PLANNER,
    urgency,
    form: form(title),
    requestedAt,
  };
}
