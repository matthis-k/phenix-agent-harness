import type { PhenixTaskService } from "@matthis-k/phenix-tasks/index.ts";
import { taskProcessEnvironment } from "@matthis-k/phenix-tasks/index.ts";
import type {
  ChildRun,
  ChildSessionBackend,
  ChildSessionSpec,
  ContractSubmissionChannel,
  ContractSubmissionResult,
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

function incompleteTaskResult(
  channel: ContractSubmissionChannel,
  taskId: string,
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
          `Owned task ${taskId} is not done. Complete and update the task subtree ` +
          "before submitting the child result.",
      },
    ],
  };
}

function guardCompletion(input: {
  readonly channel: ContractSubmissionChannel;
  readonly tasks: PhenixTaskService;
  readonly authorityToken: string;
}): ContractSubmissionChannel {
  return {
    current: () => input.channel.current(),
    async submit(value) {
      const root = input.tasks.inspect(input.authorityToken);
      if (root.explicitState !== "done") {
        return incompleteTaskResult(input.channel, root.id);
      }
      return input.channel.submit(value);
    },
    reopen: (request) => input.channel.reopen(request),
    accept: (value) => input.channel.accept(value),
    cancel: (reason) => input.channel.cancel(reason),
    readSubmitted: () => input.channel.readSubmitted(),
  };
}

/**
 * Decorates any child backend with task ownership, completion enforcement, and
 * process-environment handoff. The task capability is resolved before backend
 * startup, so in-process and process-backed implementations share semantics.
 */
export function createTaskBoundChildSessionBackend(input: {
  readonly delegate: ChildSessionBackend;
  readonly tasks: PhenixTaskService;
  readonly getBridge: () => TaskWorkflowBridge;
  readonly getEndpoint: () => Promise<string>;
}): ChildSessionBackend {
  return {
    kind: input.delegate.kind,

    async start(spec: ChildSessionSpec, signal: AbortSignal): Promise<ChildRun> {
      const authority = input.getBridge().claimChildAuthority(spec.parentContext);
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
          authorityToken: authority.token,
        }),
      };
      return input.delegate.start(taskBoundSpec, signal);
    },
  };
}
