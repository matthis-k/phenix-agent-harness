import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createTaskTools } from "@matthis-k/phenix-tasks/extension.ts";
import type { PhenixTaskService } from "@matthis-k/phenix-tasks/index.ts";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";

import { authorizePhenixRootCapability, phenixRootModelScope } from "../composition/model-scope.ts";

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "default";
}

function taskGuidance(): string {
  return [
    "## Phenix task tracking",
    "",
    "Keep the shared Phenix task tree synchronized with the work you actually perform.",
    "Use phenix_tasks to inspect your owned subtree, add child tasks before substantial independent steps, mark a task wip when starting it, and mark it done immediately after completing and verifying it.",
    "Do not use tasks as a narrative log. Keep them bounded, outcome-oriented, and current.",
    "The runtime enforces subtree ownership; never attempt to modify ancestors or sibling subtrees.",
  ].join("\n");
}

function statusText(service: PhenixTaskService, workflowId: string): string {
  const summary = service.summary(workflowId);
  return `Tasks · ${summary.done}/${summary.total} done · ${summary.wip} wip`;
}

export function registerSuiteTasks(input: {
  readonly pi: ExtensionAPI;
  readonly service: PhenixTaskService;
}): void {
  const contexts = new Map<string, ExtensionContext>();

  input.pi.on("session_start", async (_event, ctx) => {
    contexts.set(sessionId(ctx), ctx);
  });

  input.pi.on("before_agent_start", async (event, ctx) => {
    if (!phenixRootModelScope.includes(ctx.model)) return;
    const id = sessionId(ctx);
    const activeWorkflow = getSessionRuntime(id).activeWorkflow;
    if (!activeWorkflow) return;

    input.service.ensureWorkflow({
      workflowId: activeWorkflow.instanceId,
      ownerSessionId: id,
      rootActorId: activeWorkflow.actorId,
      title: event.prompt,
    });

    const systemPrompt = phenixRootModelScope.contributeSystemPrompt({
      model: ctx.model,
      systemPrompt: event.systemPrompt,
      contribution: taskGuidance(),
    });
    return systemPrompt === undefined ? undefined : { systemPrompt };
  });

  for (const tool of createTaskTools({
    service: input.service,
    resolveAuthority: (ctx) => input.service.rootAuthorityForSession(sessionId(ctx)),
    authorize: (ctx) =>
      authorizePhenixRootCapability({ ctx, capability: "phenix_tasks" }),
  })) {
    input.pi.registerTool(tool as ToolDefinition as never);
  }

  input.service.subscribe((event) => {
    const ownerSessionId = input.service.workflowOwnerSessionId(event.workflowId);
    const ctx = ownerSessionId ? contexts.get(ownerSessionId) : undefined;
    if (!ctx) return;
    try {
      ctx.ui.setStatus("phenix-tasks", statusText(input.service, event.workflowId));
      if (
        event.kind === "task.started" ||
        event.kind === "task.completed" ||
        event.kind === "task.delegated" ||
        event.kind === "task.failed"
      ) {
        const verb =
          event.kind === "task.completed"
            ? "Done"
            : event.kind === "task.failed"
              ? "Blocked"
              : event.kind === "task.delegated"
                ? "Delegated"
                : "Working";
        ctx.ui.notify(
          `${verb}: ${event.task.title}`,
          event.kind === "task.failed" ? "warning" : "info",
        );
      }
    } catch {
      // The task service remains authoritative when the UI is unavailable.
    }
  });

  input.pi.on("context", async (_event, ctx) => {
    const activeWorkflow = getSessionRuntime(sessionId(ctx)).activeWorkflow;
    if (!activeWorkflow) return;
    try {
      ctx.ui.setStatus(
        "phenix-tasks",
        statusText(input.service, activeWorkflow.instanceId),
      );
    } catch {
      // UI projection is optional.
    }
  });

  input.pi.on("session_shutdown", async (_event, ctx) => {
    contexts.delete(sessionId(ctx));
  });
}
