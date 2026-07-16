/**
 * subagent-session-runtime — application facade for child Pi sessions
 *
 * The facade is an anti-corruption boundary between the canonical execution
 * plan and the lower-level ChildSessionBackend port. It resolves model/session
 * selection, translates explicit runtime bindings, and delegates to the backend.
 */

import { agentClientRef } from "../phenix-kernel/refs.ts";
import type { ChildRun, ChildSessionBackend, ChildSessionSpec } from "./child-session-types.ts";
import type { SubagentExecutionPlan } from "./execution-plan.ts";
import { resolveSubagentSessionOptions, type SessionRouteResolver } from "./session-options.ts";

/** Deterministically translates a canonical plan into a backend specification. */
export class SubagentSessionPlanner {
  private readonly resolveRoute: SessionRouteResolver | undefined;

  constructor(resolveRoute?: SessionRouteResolver) {
    this.resolveRoute = resolveRoute;
  }

  async plan(execution: SubagentExecutionPlan<unknown>): Promise<ChildSessionSpec> {
    if (execution.assignment.task.trim().length === 0) {
      throw new Error("Subagent session task must be non-empty.");
    }

    const session = await resolveSubagentSessionOptions({
      session: execution.session.options,
      defaults: execution.session.defaults,
      ...(this.resolveRoute ? { resolveRoute: this.resolveRoute } : {}),
    });

    return {
      ...execution.runtime,
      agentClient: agentClientRef(session.agent ?? "base"),
      role: session.agent,
      model: session.model,
      thinkingLevel: session.thinking,
      initialPrompt: execution.assignment.task,
      persistence: session.persistence,
    };
  }
}

export interface SubagentSessionRuntimeOptions {
  readonly backend: ChildSessionBackend;
  /** Required only when execution plans may select routed models. */
  readonly resolveRoute?: SessionRouteResolver;
}

/** Child-session mechanism used by workflow and standalone execution services. */
export class SubagentSessionRuntime {
  private readonly backend: ChildSessionBackend;
  private readonly planner: SubagentSessionPlanner;

  constructor(options: SubagentSessionRuntimeOptions) {
    this.backend = options.backend;
    this.planner = new SubagentSessionPlanner(options.resolveRoute);
  }

  plan(execution: SubagentExecutionPlan<unknown>): Promise<ChildSessionSpec> {
    return this.planner.plan(execution);
  }

  async spawn(execution: SubagentExecutionPlan<unknown>, signal?: AbortSignal): Promise<ChildRun> {
    const spec = await this.plan(execution);
    return this.backend.start(spec, signal ?? new AbortController().signal);
  }
}

export function createSubagentSessionRuntime(
  options: SubagentSessionRuntimeOptions,
): SubagentSessionRuntime {
  return new SubagentSessionRuntime(options);
}
