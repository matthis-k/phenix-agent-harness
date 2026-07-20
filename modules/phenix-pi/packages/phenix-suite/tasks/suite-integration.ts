import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import type {
  PhenixTaskService,
  TaskNode,
  TaskState,
  TaskSummary,
} from "@matthis-k/phenix-tasks/index.ts";
import { createTaskTools } from "@matthis-k/phenix-tasks/pi-tools.ts";

import { authorizePhenixRootCapability, phenixRootModelScope } from "../composition/model-scope.ts";

const TASK_WIDGET_ID = "phenix-tasks";
const MAX_TREE_LINES = 12;

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

function statusText(summary: TaskSummary): string {
  return `Tasks · ${summary.done}/${summary.total} done · ${summary.wip} wip`;
}

function stateGlyph(state: TaskState): string {
  if (state === "done") return "✓";
  if (state === "wip") return "◐";
  return "○";
}

function assignmentSuffix(task: TaskNode): string {
  const owner =
    task.completedBySessionId ?? task.startedBySessionId ?? task.assignedSessionId;
  return owner ? ` · @${owner.slice(0, 8)}` : "";
}

function compactTitle(title: string): string {
  return title.length <= 72 ? title : `${title.slice(0, 69)}...`;
}

/** Render a bounded, stable tree suitable for Pi's small above-editor widget. */
export function renderTaskTree(
  root: TaskNode,
  summary: TaskSummary,
  maximumLines = MAX_TREE_LINES,
): readonly string[] {
  const body: string[] = [];
  let omitted = 0;

  const visit = (
    task: TaskNode,
    prefix: string,
    connector: "" | "├─ " | "└─ ",
  ): void => {
    if (body.length >= Math.max(1, maximumLines - 1)) {
      omitted += 1;
      return;
    }
    body.push(
      `${prefix}${connector}${stateGlyph(task.effectiveState)} ${compactTitle(task.title)}${assignmentSuffix(task)}`,
    );
    task.children.forEach((child, index) => {
      const last = index === task.children.length - 1;
      const childPrefix = connector === "" ? "" : `${prefix}${connector === "└─ " ? "   " : "│  "}`;
      visit(child, childPrefix, last ? "└─ " : "├─ ");
    });
  };

  visit(root, "", "");
  const lines = [statusText(summary), ...body];
  if (omitted > 0 && lines.length < maximumLines) lines.push(`… ${omitted} more`);
  return lines.slice(0, maximumLines);
}

function updateProjection(
  service: PhenixTaskService,
  workflowId: string,
  ctx: ExtensionContext,
): void {
  const summary = service.summary(workflowId);
  ctx.ui.setStatus(TASK_WIDGET_ID, statusText(summary));
  const ownerSessionId = service.workflowOwnerSessionId(workflowId);
  const authority = ownerSessionId ? service.rootAuthorityForSession(ownerSessionId) : undefined;
  if (!authority) return;
  ctx.ui.setWidget(TASK_WIDGET_ID, [...renderTaskTree(service.inspect(authority.token), summary)]);
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

    updateProjection(input.service, activeWorkflow.instanceId, ctx);
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
    authorize: (ctx) => authorizePhenixRootCapability({ ctx, capability: "phenix_tasks" }),
  })) {
    input.pi.registerTool(tool as ToolDefinition as never);
  }

  input.service.subscribe((event) => {
    const ownerSessionId = input.service.workflowOwnerSessionId(event.workflowId);
    const ctx = ownerSessionId ? contexts.get(ownerSessionId) : undefined;
    if (!ctx) return;
    try {
      updateProjection(input.service, event.workflowId, ctx);
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
      updateProjection(input.service, activeWorkflow.instanceId, ctx);
    } catch {
      // UI projection is optional.
    }
  });

  input.pi.on("session_shutdown", async (_event, ctx) => {
    contexts.delete(sessionId(ctx));
  });
}
