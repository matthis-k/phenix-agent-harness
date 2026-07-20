import type { TaskAuthority, TaskRuntimeFacade } from "@matthis-k/phenix-tasks/index.ts";
import { taskProcessEnvironment } from "@matthis-k/phenix-tasks/index.ts";
import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionEvent,
  ChildSessionSpec,
  ContractSubmissionChannel,
  ContractSubmissionResult,
  ExecutionIssue,
} from "../runtime/child-session-types.ts";

import type { TaskWorkflowBridge } from "./task-workflow-bridge.ts";

export interface TaskBoundChildSessionSpec extends ChildSessionSpec {
  /**
   * Runtime-only environment for a backend that launches the child in another
   * process. SDK children ignore it and use the same scoped capability through
   * their in-process tool adapter.
   */
  readonly runtimeEnvironment: Readonly<Record<string, string>>;
}

export function taskRuntimeEnvironment(
  spec: ChildSessionSpec,
): Readonly<Record<string, string>> | undefined {
  return (spec as Partial<TaskBoundChildSessionSpec>).runtimeEnvironment;
}

export function taskAuthorityTokenFromSpec(spec: ChildSessionSpec): string | undefined {
  return taskRuntimeEnvironment(spec)?.PHENIX_TASKS_CAPABILITY;
}

function compactDiagnostic(message: string): string {
  const normalized = message.trim().replace(/\s+/g, " ");
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}

function appendDiagnostic(
  tasks: TaskRuntimeFacade,
  authority: TaskAuthority,
  message: string,
): void {
  try {
    tasks.appendLog(authority.token, {
      uid: authority.scopeTaskId,
      message: compactDiagnostic(message),
    });
  } catch {
    // Diagnostics must never alter child execution semantics.
  }
}

function messageFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (value instanceof Error && value.message.trim().length > 0) return value.message.trim();
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return (
    messageFromUnknown(record.errorMessage) ??
    messageFromUnknown(record.message) ??
    messageFromUnknown(record.error)
  );
}

function providerEventDiagnostic(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
  const hasFailure = type === "error" || record.error != null || record.errorMessage != null;
  if (!hasFailure) return undefined;
  const code = typeof record.code === "string" && record.code.length > 0 ? record.code : undefined;
  const message =
    messageFromUnknown(record.error) ??
    messageFromUnknown(record.errorMessage) ??
    messageFromUnknown(record.message) ??
    "Provider/model emitted an error event without a message.";
  return `Provider event type=${type}${code ? `, code=${code}` : ""}: ${message}`;
}

function issueDiagnostic(issues: readonly ExecutionIssue[] | undefined): string {
  if (!issues || issues.length === 0) return "no issue details";
  return issues
    .slice(0, 4)
    .map((issue) => `${issue.code ?? "ISSUE"}: ${issue.message}`)
    .join(" | ");
}

function incompleteTaskResult(
  channel: ContractSubmissionChannel,
  taskUid: string,
): ContractSubmissionResult {
  const attempt = channel.current();
  return {
    ok: false,
    state: attempt.state,
    revision: attempt.revision,
    issues: [
      {
        path: [],
        code: "TASK_SUBTREE_INCOMPLETE",
        message:
          `Owned task ${taskUid} is not done. Complete and update the task subtree ` +
          "before submitting the child result.",
      },
    ],
  };
}

function guardCompletion(input: {
  readonly channel: ContractSubmissionChannel;
  readonly tasks: TaskRuntimeFacade;
  readonly authority: TaskAuthority;
}): ContractSubmissionChannel {
  return {
    current: () => input.channel.current(),
    async submit(value) {
      const root = input.tasks.inspect(input.authority.token);
      if (root.ownStatus !== "done") {
        appendDiagnostic(
          input.tasks,
          input.authority,
          `Contract submission blocked: owned task status=${root.ownStatus}; complete the task subtree first.`,
        );
        return incompleteTaskResult(input.channel, root.uid);
      }
      const result = await input.channel.submit(value);
      appendDiagnostic(
        input.tasks,
        input.authority,
        result.ok
          ? `Contract result submitted: revision=${result.revision}, state=${result.state}.`
          : `Contract submission rejected: revision=${result.revision}, state=${result.state}, ${issueDiagnostic(result.issues)}.`,
      );
      return result;
    },
    async reopen(request) {
      appendDiagnostic(
        input.tasks,
        input.authority,
        `Contract reopened: reason=${request.reason}, ${issueDiagnostic(request.issues)}.`,
      );
      await input.channel.reopen(request);
    },
    async accept(value) {
      appendDiagnostic(input.tasks, input.authority, "Contract result accepted.");
      await input.channel.accept(value);
    },
    async cancel(reason) {
      appendDiagnostic(input.tasks, input.authority, `Contract cancelled: ${reason}`);
      await input.channel.cancel(reason);
    },
    readSubmitted: () => input.channel.readSubmitted(),
  };
}

function bindRunDiagnostics(input: {
  readonly run: ChildRun;
  readonly tasks: TaskRuntimeFacade;
  readonly authority: TaskAuthority;
}): void {
  const seen = new Set<string>();
  const log = (message: string): void => {
    const compacted = compactDiagnostic(message);
    if (seen.has(compacted)) return;
    seen.add(compacted);
    appendDiagnostic(input.tasks, input.authority, compacted);
  };

  log(
    `Child backend ready: backend=${input.run.backend}, run=${input.run.id}, pi-session=${input.run.pi.sessionId}.`,
  );
  input.run.subscribe((event: ChildSessionEvent) => {
    switch (event.type) {
      case "session.started":
        log(`Child session started: pi-session=${event.pi.sessionId}.`);
        return;
      case "session.failed":
        log(
          `Child session failed: code=${event.error.code}, message=${event.error.message}${event.error.cause ? `, cause=${event.error.cause}` : ""}.`,
        );
        return;
      case "session.cancelled":
        log(`Child session cancelled: ${event.reason}`);
        return;
      case "cycle.settled":
        log(`Child cycle settled: cycle=${event.cycle}.`);
        return;
      case "tool.completed":
        if (event.isError) log(`Child tool failed: ${event.toolName}.`);
        return;
      case "agent.event": {
        const diagnostic = providerEventDiagnostic(event.event);
        if (diagnostic) log(diagnostic);
        return;
      }
      case "tool.started":
      case "session.disposed":
        return;
    }
  });
}

/**
 * Decorates any child backend with task ownership, completion enforcement,
 * process-environment handoff, and bounded lifecycle diagnostics. The task
 * capability is resolved before backend startup, so in-process and
 * process-backed implementations share semantics.
 */
export function createTaskBoundChildSessionBackend(input: {
  readonly delegate: ChildSessionBackend;
  readonly tasks: TaskRuntimeFacade;
  readonly getBridge: () => TaskWorkflowBridge;
  readonly getEndpoint: () => Promise<string>;
}): ChildSessionBackend {
  return {
    kind: input.delegate.kind,

    async start(spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun> {
      const authority = input.getBridge().claimChildAuthority(spec.parentContext);
      appendDiagnostic(
        input.tasks,
        authority,
        `Child backend starting: backend=${input.delegate.kind}, run=${spec.id}, model=${spec.model.provider}/${spec.model.id}, thinking=${spec.thinkingLevel}.`,
      );

      try {
        const runtimeEnvironment = taskProcessEnvironment({
          endpoint: await input.getEndpoint(),
          authority,
        });
        const taskBoundSpec: TaskBoundChildSessionSpec = {
          ...spec,
          runtimeEnvironment,
          contractChannel: guardCompletion({
            channel: spec.contractChannel,
            tasks: input.tasks,
            authority,
          }),
        };
        const run = await input.delegate.start(taskBoundSpec, signal);
        bindRunDiagnostics({ run, tasks: input.tasks, authority });
        return run;
      } catch (error) {
        appendDiagnostic(
          input.tasks,
          authority,
          `Child backend start failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    },
  };
}
