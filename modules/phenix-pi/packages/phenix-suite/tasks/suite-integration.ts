import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import type {
  TaskReference,
  TaskRuntimeFacade,
  TaskStatus,
  TaskSummary,
  TaskTreeNode,
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
    "Keep the shared Phenix task tree synchronized with actual execution.",
    "Use short names and descriptions. Add bounded child tasks before independent work, update status when work starts or completes, and append brief process updates to the relevant task with phenix_tasks action=log.",
    "Task logs are append-only operational history; do not copy them into parent context or create narrative tasks for every tool call.",
    "The runtime enforces subtree ownership; never modify ancestors or sibling subtrees.",
  ].join("\n");
}

function statusText(summary: TaskSummary): string {
  return `Tasks · ${summary.done}/${summary.total} done · ${summary.wip} wip`;
}

function stateGlyph(status: TaskStatus): string {
  if (status === "done") return "✓";
  if (status === "wip") return "◐";
  return "○";
}

function assignmentSuffix(task: TaskTreeNode): string {
  const owner = task.completedBySessionId ?? task.startedBySessionId ?? task.assignedSessionId;
  return owner ? ` · @${owner.slice(0, 8)}` : "";
}

function compact(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

export function renderTaskTree(
  root: TaskTreeNode,
  summary: TaskSummary,
  maximumLines = MAX_TREE_LINES,
): readonly string[] {
  const body: string[] = [];
  let omitted = 0;
  const visit = (task: TaskTreeNode, prefix: string, connector: "" | "├─ " | "└─ "): void => {
    if (body.length >= Math.max(1, maximumLines - 1)) {
      omitted += 1;
      return;
    }
    const description = task.description ? ` — ${compact(task.description, 54)}` : "";
    body.push(
      `${prefix}${connector}${stateGlyph(task.status)} ${compact(task.name, 52)}${description}${assignmentSuffix(task)}`,
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

export function taskCommandCompletions(
  prefix: string,
  references: readonly TaskReference[],
): readonly { value: string; label: string; description?: string }[] | null {
  if (!prefix.startsWith("log ")) {
    return "log ".startsWith(prefix)
      ? [{ value: "log ", label: "log <task>", description: "Open an exact task log" }]
      : null;
  }
  const query = prefix.slice("log ".length);
  const values = new Map<string, { value: string; label: string; description?: string }>();
  for (const reference of references) {
    for (const selector of [reference.path, reference.uid]) {
      if (!selector.startsWith(query)) continue;
      values.set(selector, {
        value: `log ${selector}`,
        label: selector,
        description: `${reference.status} · ${reference.name}`,
      });
    }
  }
  return values.size > 0 ? [...values.values()] : null;
}

function updateProjection(
  service: TaskRuntimeFacade,
  workflowId: string,
  ctx: ExtensionContext,
): readonly TaskReference[] {
  const summary = service.summary(workflowId);
  ctx.ui.setStatus(TASK_WIDGET_ID, statusText(summary));
  const ownerSessionId = service.workflowOwnerSessionId(workflowId);
  const authority = ownerSessionId ? service.rootAuthorityForSession(ownerSessionId) : undefined;
  if (!authority) return [];
  ctx.ui.setWidget(TASK_WIDGET_ID, [...renderTaskTree(service.inspect(authority.token), summary)]);
  return service.references(authority.token);
}

export function registerSuiteTasks(input: {
  readonly pi: ExtensionAPI;
  readonly service: TaskRuntimeFacade;
}): void {
  const contexts = new Map<string, ExtensionContext>();
  let completionReferences: readonly TaskReference[] = [];

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
    completionReferences = updateProjection(input.service, activeWorkflow.instanceId, ctx);
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

  input.pi.registerCommand("phenix-tasks", {
    description: "Inspect a Phenix task log: /phenix-tasks log <exact-path-or-uid>",
    getArgumentCompletions: (prefix) => taskCommandCompletions(prefix, completionReferences),
    handler: async (args, ctx) => {
      const match = /^log\s+(.+)$/.exec(args.trim());
      if (!match) {
        ctx.ui.notify("Usage: /phenix-tasks log <exact-task-path-or-uid>", "warning");
        return;
      }
      const activeWorkflow = getSessionRuntime(sessionId(ctx)).activeWorkflow;
      const authority = activeWorkflow
        ? input.service.rootAuthorityForSession(sessionId(ctx))
        : undefined;
      if (!activeWorkflow || !authority) {
        ctx.ui.notify("No active Phenix task tree is bound to this session.", "warning");
        return;
      }
      try {
        const task = input.service.readLog(authority.token, match[1]);
        const metadata = [
          `UID: ${task.uid}`,
          `Name: ${task.name}`,
          `Description: ${task.description ?? "—"}`,
          `Status: ${task.status}`,
        ];
        const entries = task.log.map(
          (entry) => `${entry.timestamp} · @${entry.sessionId.slice(0, 8)} · ${entry.message}`,
        );
        await ctx.ui.select(`Phenix task log · ${task.path}`, [
          ...metadata,
          "────────",
          ...(entries.length > 0 ? entries : ["No process updates recorded."]),
        ]);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  input.service.subscribe((event) => {
    const ownerSessionId = input.service.workflowOwnerSessionId(event.workflowId);
    const ctx = ownerSessionId ? contexts.get(ownerSessionId) : undefined;
    if (!ctx) return;
    try {
      completionReferences = updateProjection(input.service, event.workflowId, ctx);
      if (
        ["task.started", "task.completed", "task.delegated", "task.failed"].includes(event.kind)
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
          `${verb}: ${event.task.name}`,
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
      completionReferences = updateProjection(input.service, activeWorkflow.instanceId, ctx);
    } catch {
      // UI projection is optional.
    }
  });

  input.pi.on("session_shutdown", async (_event, ctx) => {
    contexts.delete(sessionId(ctx));
  });
}
