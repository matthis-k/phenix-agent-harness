/**
 * workflow-execution-compiler — compile an authorized workflow scope
 *
 * Workflow authority resolves role, routing defaults, runtime bindings, and the
 * acceptance policy before exposing a compiler. The compiler then translates
 * the same public SubagentRequest used elsewhere into the canonical passive plan.
 */

import type { AgentRole } from "../phenix-kernel/agents.ts";
import type { ModelSetId } from "../phenix-kernel/ids.ts";
import type { Difficulty, ThinkingLevel } from "../phenix-kernel/task.ts";
import type {
  AcceptancePlan,
  RuntimeBindings,
  SubagentExecutionCompiler,
  SubagentExecutionPlan,
} from "../phenix-runtime/execution-plan.ts";
import type { SessionPersistence } from "../phenix-runtime/session-options.ts";
import type { SubagentRequest } from "../phenix-runtime/subagent-api.ts";

export interface WorkflowExecutionScope {
  readonly role: AgentRole;
  readonly modelSet: ModelSetId;
  readonly difficulty: Difficulty;
  readonly thinking: ThinkingLevel;
  readonly persistence: SessionPersistence;
  readonly runtime: RuntimeBindings;
  readonly acceptanceKind?: string;
  readonly acceptanceData?: unknown;
}

/**
 * Compiler scoped to one already-authorized workflow transition.
 *
 * Callers may provide a concrete/routed model selector, but workflow-owned role,
 * difficulty, thinking, persistence, and runtime authority remain authoritative.
 */
export class WorkflowExecutionCompiler implements SubagentExecutionCompiler {
  private readonly scope: WorkflowExecutionScope;

  constructor(scope: WorkflowExecutionScope) {
    this.scope = scope;
  }

  compile<TOutput>(
    request: SubagentRequest<TOutput>,
    signal: AbortSignal,
  ): Promise<SubagentExecutionPlan<TOutput>> {
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new Error("Workflow execution compilation aborted."));
    }

    const acceptance: AcceptancePlan<TOutput> = {
      kind: this.scope.acceptanceKind ?? "workflow",
      returns: request.returns,
      ...(this.scope.acceptanceData !== undefined
        ? { data: this.scope.acceptanceData }
        : {}),
    };

    return Promise.resolve({
      assignment: {
        task: request.task,
        requirements: request.requirements ?? [],
      },
      session: {
        options: {
          ...request.session,
          agent: this.scope.role,
          thinking: this.scope.thinking,
          persistence: this.scope.persistence,
        },
        defaults: {
          agent: this.scope.role,
          modelSet: this.scope.modelSet,
          difficulty: this.scope.difficulty,
          thinking: this.scope.thinking,
          persistence: this.scope.persistence,
        },
      },
      runtime: this.scope.runtime,
      acceptance,
    });
  }
}

export function createWorkflowExecutionCompiler(
  scope: WorkflowExecutionScope,
): WorkflowExecutionCompiler {
  return new WorkflowExecutionCompiler(scope);
}
