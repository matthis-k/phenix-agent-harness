/**
 * subagent-session-runtime — application facade for child Pi sessions
 *
 * The facade is an anti-corruption boundary between declarative Phenix session
 * requests and the lower-level ChildSessionBackend port. The planner resolves
 * routing and defaults into an immutable ChildSessionSpec; the runtime then
 * delegates that specification to the selected backend adapter.
 */

import { agentClientRef } from "../phenix-kernel/refs.ts";
import type { ChildRun, ChildSessionBackend, ChildSessionSpec } from "./child-session-types.ts";
import {
  resolveSubagentSessionOptions,
  type SessionRouteResolver,
  type SubagentSessionDefaults,
  type SubagentSessionOptions,
} from "./session-options.ts";

/**
 * Runtime-owned bindings that are already resolved before a session is
 * planned. They contain contracts, workflow authority, capabilities, budgets,
 * and stable identities, but no model/session-selection decisions.
 */
export type SubagentSessionBindings = Omit<
  ChildSessionSpec,
  "agentClient" | "role" | "model" | "thinkingLevel" | "initialPrompt" | "persistence"
>;

/**
 * Easy-to-use session creation request.
 *
 * `session` is the only caller-facing selection surface. `bindings` remains a
 * nested runtime concern so workflows can supply authority and policy without
 * leaking Pi SDK construction details into the public options object.
 */
export interface SubagentSessionRequest {
  readonly task: string;
  readonly session?: SubagentSessionOptions;
  readonly defaults: SubagentSessionDefaults;
  readonly bindings: SubagentSessionBindings;
}

/** Deterministically translates a declarative request into a backend spec. */
export class SubagentSessionPlanner {
  private readonly resolveRoute: SessionRouteResolver;

  constructor(resolveRoute: SessionRouteResolver) {
    this.resolveRoute = resolveRoute;
  }

  async plan(request: SubagentSessionRequest): Promise<ChildSessionSpec> {
    if (request.task.trim().length === 0) {
      throw new Error("Subagent session task must be non-empty.");
    }

    const session = await resolveSubagentSessionOptions({
      session: request.session,
      defaults: request.defaults,
      resolveRoute: this.resolveRoute,
    });

    return {
      ...request.bindings,
      agentClient: agentClientRef(session.agent ?? "base"),
      role: session.agent,
      model: session.model,
      thinkingLevel: session.thinking,
      initialPrompt: request.task,
      persistence: session.persistence,
    };
  }
}

export interface SubagentSessionRuntimeOptions {
  readonly backend: ChildSessionBackend;
  readonly resolveRoute: SessionRouteResolver;
  readonly planner?: SubagentSessionPlanner;
}

/**
 * Facade used by workflow and standalone orchestration code.
 *
 * The backend remains a narrow port over the Pi runtime. Callers interact with
 * declarative requests and never construct ChildSessionSpec directly.
 */
export class SubagentSessionRuntime {
  private readonly backend: ChildSessionBackend;
  private readonly planner: SubagentSessionPlanner;

  constructor(options: SubagentSessionRuntimeOptions) {
    this.backend = options.backend;
    this.planner = options.planner ?? new SubagentSessionPlanner(options.resolveRoute);
  }

  plan(request: SubagentSessionRequest): Promise<ChildSessionSpec> {
    return this.planner.plan(request);
  }

  async spawn(request: SubagentSessionRequest, signal?: AbortSignal): Promise<ChildRun> {
    const spec = await this.plan(request);
    return this.backend.start(spec, signal ?? new AbortController().signal);
  }
}

export function createSubagentSessionRuntime(
  options: SubagentSessionRuntimeOptions,
): SubagentSessionRuntime {
  return new SubagentSessionRuntime(options);
}
