/**
 * subagent-session-runtime — application facade for child Pi sessions
 *
 * The facade is an anti-corruption boundary between the canonical execution
 * plan and the lower-level ChildSessionBackend port. It resolves model/session
 * selection, translates explicit runtime bindings, and delegates to the backend.
 */

import { agentClientRef } from "../phenix-kernel/refs.ts";
import type { ChildRun, ChildSessionBackend, ChildSessionSpec } from "./child-session-types.ts";
import type {
  RuntimeBindings,
  SubagentExecutionPlan,
} from "./execution-plan.ts";
import {
  resolveSubagentSessionOptions,
  type SessionRouteResolver,
  type SubagentSessionDefaults,
  type SubagentSessionOptions,
} from "./session-options.ts";

/**
 * Transitional input accepted only at this boundary while workflow composition
 * is migrated. It is immediately normalized and is intentionally not exported.
 */
interface LegacySubagentSessionRequest {
  readonly task: string;
  readonly session?: SubagentSessionOptions;
  readonly defaults: SubagentSessionDefaults;
  readonly bindings: RuntimeBindings;
}

type SessionExecutionInput = SubagentExecutionPlan<unknown> | LegacySubagentSessionRequest;

function isExecutionPlan(input: SessionExecutionInput): input is SubagentExecutionPlan<unknown> {
  return "assignment" in input && "runtime" in input && "acceptance" in input;
}

function normalizeExecutionPlan(input: SessionExecutionInput): SubagentExecutionPlan<unknown> {
  if (isExecutionPlan(input)) return input;

  return {
    assignment: {
      task: input.task,
      requirements: [],
    },
    session: {
      options: input.session,
      defaults: input.defaults,
    },
    runtime: input.bindings,
    acceptance: {
      kind: "legacy-session",
      returns: { schema: {} },
    },
  };
}

/** Deterministically translates a canonical plan into a backend specification. */
export class SubagentSessionPlanner {
  private readonly resolveRoute: SessionRouteResolver;

  constructor(resolveRoute: SessionRouteResolver) {
    this.resolveRoute = resolveRoute;
  }

  async plan(input: SessionExecutionInput): Promise<ChildSessionSpec> {
    const execution = normalizeExecutionPlan(input);
    if (execution.assignment.task.trim().length === 0) {
      throw new Error("Subagent session task must be non-empty.");
    }

    const session = await resolveSubagentSessionOptions({
      session: execution.session.options,
      defaults: execution.session.defaults,
      resolveRoute: this.resolveRoute,
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
  readonly resolveRoute: SessionRouteResolver;
}

/** Child-session mechanism used by workflow and standalone execution services. */
export class SubagentSessionRuntime {
  private readonly backend: ChildSessionBackend;
  private readonly planner: SubagentSessionPlanner;

  constructor(options: SubagentSessionRuntimeOptions) {
    this.backend = options.backend;
    this.planner = new SubagentSessionPlanner(options.resolveRoute);
  }

  plan(input: SessionExecutionInput): Promise<ChildSessionSpec> {
    return this.planner.plan(input);
  }

  async spawn(input: SessionExecutionInput, signal?: AbortSignal): Promise<ChildRun> {
    const spec = await this.plan(input);
    return this.backend.start(spec, signal ?? new AbortController().signal);
  }
}

export function createSubagentSessionRuntime(
  options: SubagentSessionRuntimeOptions,
): SubagentSessionRuntime {
  return new SubagentSessionRuntime(options);
}
