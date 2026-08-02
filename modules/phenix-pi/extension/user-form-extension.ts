import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

import type { UserFormFacade } from "../application/user-form-service.ts";
import type { RunId } from "../domain/shared.ts";
import type { UserFormCounts, UserFormId, UserFormRequest } from "../domain/user-form/model.ts";
import { heading, type ObservabilityTheme } from "./observability-theme.ts";
import {
  InlineUserFormSession,
  type InlineUserFormSnapshot,
  orderPendingUserForms,
} from "./workspace/inline-user-form-session.ts";
import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";

const STATUS_KEY = "01-userforms";
export const USER_FORM_ENTRY_TYPE = "phenix:userform";
const sessions = new WeakMap<UserFormFacade, Map<RunId, InlineUserFormSession>>();

export type UserFormEntryPhase = "requested" | "answered" | "completed" | "cancelled";

export interface UserFormEntryData {
  readonly content: string;
  readonly formId: UserFormId;
  readonly requestedByRunId: RunId;
  readonly phase: UserFormEntryPhase;
}

const USER_FORM_ENTRY_PHASES = new Set<UserFormEntryPhase>([
  "requested",
  "answered",
  "completed",
  "cancelled",
]);

export default function registerUserForms(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let binding: WorkspaceRuntimeBinding | undefined;
  let disposeForms: (() => void) | undefined;
  const announced = new Set<UserFormId>();

  pi.registerEntryRenderer(USER_FORM_ENTRY_TYPE, (entry, _options, theme) => {
    const data = userFormEntryData(entry.data);
    return data ? renderUserFormEntry(data, theme) : new Text("User form", 0, 0);
  });

  const refresh = (): void => {
    const ctx = context;
    const active = binding;
    if (!ctx || !active) {
      ctx?.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const pending = orderPendingUserForms(active.runtime.userForms.list(active.rootRunId));
    ctx.ui.setStatus(
      STATUS_KEY,
      formatUserFormStatus(active.runtime.userForms.counts(active.rootRunId)),
    );
    for (const request of pending) {
      if (announced.has(request.id)) continue;
      announced.add(request.id);
      publishUserForm(pi, initialSnapshot(request), "requested");
    }
  };

  subscribeWorkspaceRuntime(pi.events, (next) => {
    disposeForms?.();
    disposeForms = undefined;
    binding = next;
    announced.clear();
    if (next) disposeForms = next.runtime.userForms.subscribe(refresh);
    refresh();
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    refresh();
  });

  pi.on("input", async (event) => {
    const active = binding;
    if (!active || event.text.trimStart().startsWith("/")) return { action: "continue" };
    if (!routeUserFormInput(pi, active, event.text)) return { action: "continue" };
    return { action: "handled" };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    disposeForms?.();
    disposeForms = undefined;
    binding = undefined;
    context = undefined;
    announced.clear();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("userforms", {
    description: "Show the active inline Phenix user form",
    handler: async (_args, ctx) => {
      context = ctx;
      const active = binding;
      if (!active) {
        ctx.ui.notify("Phenix runtime is not initialized.", "warning");
        return;
      }
      await openUserFormInbox(ctx, active);
    },
  });

  pi.registerCommand("userform-cancel", {
    description: "Cancel the active inline Phenix user form",
    handler: async (_args, ctx) => {
      const active = binding;
      if (!active) {
        ctx.ui.notify("Phenix runtime is not initialized.", "warning");
        return;
      }
      const session = inlineSession(active);
      const snapshot = session.active();
      if (!snapshot) {
        ctx.ui.notify("No pending user form.", "info");
        return;
      }
      publishCancelledUserForm(pi, snapshot.request);
      session.cancel();
      ctx.ui.notify(`Cancelled user form: ${snapshot.request.form.title}`, "warning");
    },
  });
}

export function routeUserFormInput(
  pi: Pick<ExtensionAPI, "appendEntry">,
  binding: WorkspaceRuntimeBinding,
  text: string,
): boolean {
  const session = inlineSession(binding);
  if (!session.active()) return false;
  const update = session.answer(text);
  if (!update) return false;
  publishUserForm(pi, update, update.completed ? "completed" : "answered");
  return true;
}

export function formatUserFormStatus(counts: UserFormCounts): string | undefined {
  if (counts.total === 0) return undefined;
  return counts.urgent > 0
    ? `forms ${counts.total} pending · ${counts.urgent} urgent · answer in input`
    : `forms ${counts.total} pending · answer in input`;
}

export { orderPendingUserForms };

export async function openUserFormInbox(
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
): Promise<void> {
  const snapshot = inlineSession(binding).active();
  if (!snapshot) {
    ctx.ui.notify("No pending user forms.", "info");
    return;
  }
  const question = snapshot.request.form.questions[snapshot.questionIndex];
  ctx.ui.notify(
    question
      ? `User form from ${snapshot.request.requestedByRunId}: ${snapshot.request.form.title} — ${question.prompt}`
      : `User form from ${snapshot.request.requestedByRunId}: ${snapshot.request.form.title}`,
    snapshot.request.urgency === "urgent" ? "warning" : "info",
  );
}

export function userFormEntryData(value: unknown): UserFormEntryData | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.content !== "string" ||
    typeof value.formId !== "string" ||
    typeof value.requestedByRunId !== "string" ||
    typeof value.phase !== "string" ||
    !USER_FORM_ENTRY_PHASES.has(value.phase as UserFormEntryPhase)
  ) {
    return undefined;
  }
  return {
    content: value.content,
    formId: value.formId as UserFormId,
    requestedByRunId: value.requestedByRunId as RunId,
    phase: value.phase as UserFormEntryPhase,
  };
}

export function renderUserFormEntry(
  data: UserFormEntryData,
  theme?: ObservabilityTheme,
): Component {
  const [title = "User form", ...body] = data.content.split("\n");
  return new Text([heading(theme, title), ...body].join("\n"), 0, 0);
}

function inlineSession(binding: WorkspaceRuntimeBinding): InlineUserFormSession {
  let byRoot = sessions.get(binding.runtime.userForms);
  if (!byRoot) {
    byRoot = new Map();
    sessions.set(binding.runtime.userForms, byRoot);
  }
  const existing = byRoot.get(binding.rootRunId);
  if (existing) return existing;
  const created = new InlineUserFormSession(binding.runtime.userForms, binding.rootRunId);
  byRoot.set(binding.rootRunId, created);
  return created;
}

function initialSnapshot(request: UserFormRequest): InlineUserFormSnapshot {
  return {
    request,
    questionIndex: 0,
    answers: request.form.questions.map((question) => ({
      questionId: question.id,
      answer: question.initialAnswer ?? "",
    })),
    completed: false,
  };
}

function publishUserForm(
  pi: Pick<ExtensionAPI, "appendEntry">,
  snapshot: InlineUserFormSnapshot,
  phase: Exclude<UserFormEntryPhase, "cancelled">,
): void {
  appendUserFormEntry(pi, {
    content: formatInlineUserForm(snapshot, phase),
    formId: snapshot.request.id,
    requestedByRunId: snapshot.request.requestedByRunId,
    phase,
  });
}

function publishCancelledUserForm(
  pi: Pick<ExtensionAPI, "appendEntry">,
  request: UserFormRequest,
): void {
  appendUserFormEntry(pi, {
    content: `User form from ${request.requestedByRunId}\n${request.form.title}\nCancelled by user.`,
    formId: request.id,
    requestedByRunId: request.requestedByRunId,
    phase: "cancelled",
  });
}

function appendUserFormEntry(pi: Pick<ExtensionAPI, "appendEntry">, data: UserFormEntryData): void {
  pi.appendEntry(USER_FORM_ENTRY_TYPE, data);
}

function formatInlineUserForm(
  snapshot: InlineUserFormSnapshot,
  phase: Exclude<UserFormEntryPhase, "cancelled">,
): string {
  const request = snapshot.request;
  const lines = [
    `User form from ${request.requestedByRunId}${request.urgency === "urgent" ? " · URGENT" : ""}`,
    request.form.title,
  ];
  if (request.form.description) lines.push(request.form.description);

  for (const [index, question] of request.form.questions.entries()) {
    const answer = snapshot.answers[index]?.answer ?? "";
    const current = !snapshot.completed && index === snapshot.questionIndex;
    const marker = answer.trim() ? "✓" : current ? "→" : "·";
    lines.push(`${marker} ${index + 1}. ${question.prompt}${question.required ? " *" : ""}`);
    if (answer.trim()) lines.push(`  ${answer}`);
    if (current && question.description) lines.push(`  ${question.description}`);
    if (current && question.suggestions.length > 0) {
      lines.push(
        `  Suggestions: ${question.suggestions
          .map((suggestion, suggestionIndex) => `${suggestionIndex + 1}) ${suggestion.label}`)
          .join(" · ")}`,
      );
    }
  }

  if (phase === "completed") lines.push("Submitted.");
  else lines.push("Reply using the normal input. A suggestion can be selected by number.");
  return lines.join("\n");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
