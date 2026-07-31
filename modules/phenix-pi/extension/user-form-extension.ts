import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { UserFormCounts, UserFormRequest } from "../domain/user-form/model.ts";
import { UserFormDialog } from "./workspace/user-form-dialog.ts";
import {
  WorkspaceSelectDialog,
  type WorkspaceSelectDialogItem,
} from "./workspace/workspace-select-dialog.ts";
import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";

const STATUS_KEY = "01-userforms";

export default function registerUserForms(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let binding: WorkspaceRuntimeBinding | undefined;
  let disposeForms: (() => void) | undefined;
  let opening = false;

  const refresh = (): void => {
    const ctx = context;
    const active = binding;
    if (!ctx || !active) {
      ctx?.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(
      STATUS_KEY,
      formatUserFormStatus(active.runtime.userForms.counts(active.rootRunId)),
    );
  };

  subscribeWorkspaceRuntime(pi.events, (next) => {
    disposeForms?.();
    disposeForms = undefined;
    binding = next;
    if (next) disposeForms = next.runtime.userForms.subscribe(refresh);
    refresh();
  });

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    refresh();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    disposeForms?.();
    disposeForms = undefined;
    binding = undefined;
    context = undefined;
    opening = false;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerCommand("userforms", {
    description: "Open the pending Phenix user-form inbox",
    handler: async (_args, ctx) => {
      context = ctx;
      const active = binding;
      if (!active) {
        ctx.ui.notify("Phenix runtime is not initialized.", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        const counts = active.runtime.userForms.counts(active.rootRunId);
        ctx.ui.notify(formatUserFormSummary(counts), counts.urgent > 0 ? "warning" : "info");
        return;
      }
      if (opening) return;
      opening = true;
      try {
        await openUserFormInbox(ctx, active);
      } finally {
        opening = false;
        refresh();
      }
    },
  });
}

export function formatUserFormStatus(counts: UserFormCounts): string | undefined {
  if (counts.total === 0) return undefined;
  return counts.urgent > 0
    ? `forms ${counts.total} pending · ${counts.urgent} urgent · /userforms`
    : `forms ${counts.total} pending · /userforms`;
}

export function orderPendingUserForms(
  requests: readonly UserFormRequest[],
): readonly UserFormRequest[] {
  return [...requests].sort((left, right) => {
    if (left.urgency !== right.urgency) return left.urgency === "urgent" ? -1 : 1;
    return left.requestedAt.localeCompare(right.requestedAt);
  });
}

export async function openUserFormInbox(
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
): Promise<void> {
  while (true) {
    const requests = orderPendingUserForms(
      binding.runtime.userForms.list(binding.rootRunId),
    );
    if (requests.length === 0) {
      ctx.ui.notify("No pending user forms.", "info");
      return;
    }

    const selected = await selectPendingUserForm(ctx, requests);
    if (!selected) return;
    const current = binding.runtime.userForms.get(selected.id);
    if (!current || current.rootRunId !== binding.rootRunId) {
      ctx.ui.notify("That user form is no longer pending.", "info");
      continue;
    }
    await openUserForm(ctx, binding, current);
  }
}

async function selectPendingUserForm(
  ctx: ExtensionContext,
  requests: readonly UserFormRequest[],
): Promise<UserFormRequest | undefined> {
  const items: WorkspaceSelectDialogItem<UserFormRequest>[] = requests.map((request, index) => ({
    id: request.id,
    label: request.form.title,
    detail: `${request.urgency === "urgent" ? "URGENT · " : ""}${request.form.questions.length} question${request.form.questions.length === 1 ? "" : "s"} · ${request.requestedByRunId}`,
    searchText: [
      request.requestedByRunId,
      request.form.description,
      ...request.form.questions.map((question) => question.prompt),
    ]
      .filter(Boolean)
      .join(" "),
    current: index === 0,
    value: request,
  }));

  return ctx.ui.custom<UserFormRequest | undefined>(
    (tui, theme, keybindings, done) =>
      new WorkspaceSelectDialog({
        tui,
        theme,
        keybindings,
        title: `Pending user forms (${requests.length})`,
        items,
        emptyMessage: "No pending user forms",
        onClose: done,
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "78%",
        maxHeight: "80%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

async function openUserForm(
  ctx: ExtensionContext,
  binding: WorkspaceRuntimeBinding,
  request: UserFormRequest,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new UserFormDialog({
        tui,
        theme,
        keybindings,
        request,
        onClose: (completion) => {
          binding.runtime.userForms.complete(request.id, completion);
          done(undefined);
        },
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "88%",
        maxHeight: "90%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

function formatUserFormSummary(counts: UserFormCounts): string {
  if (counts.total === 0) return "No pending user forms.";
  return counts.urgent > 0
    ? `${counts.total} pending user forms, including ${counts.urgent} urgent.`
    : `${counts.total} pending user form${counts.total === 1 ? "" : "s"}.`;
}
