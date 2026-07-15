/**
 * execution-plan — canonical passive representation of one subagent execution
 *
 * Public requests are compiled into this data structure. The plan contains no
 * executable closures and does not inherit its shape through Omit/Pick from a
 * backend DTO. Dedicated services resolve the session and evaluate acceptance.
 */

import type { ReturnSpec } from "./subagent-api.ts";
import type { ChildRun, ChildSessionSpec } from "./child-session-types.ts";
import type {
  SubagentSessionDefaults,
  SubagentSessionOptions,
} from "./session-options.ts";

/**
 * Runtime-owned values required to construct a child session.
 *
 * The field list is explicit so additions to ChildSessionSpec cannot silently
 * leak into the application model. Indexed field types retain compatibility
 * with the current backend while keeping ownership of the shape here.
 */
export interface RuntimeBindings {
  readonly id: ChildSessionSpec["id"];
  readonly parentId?: ChildSessionSpec["parentId"];
  readonly rootId: ChildSessionSpec["rootId"];
  readonly handleId: ChildSessionSpec["handleId"];
  readonly cwd: ChildSessionSpec["cwd"];
  readonly contract: ChildSessionSpec["contract"];
  readonly workflowProjection: ChildSessionSpec["workflowProjection"];
  readonly contractChannel: ChildSessionSpec["contractChannel"];
  readonly parentContext: ChildSessionSpec["parentContext"];
  readonly effectiveTools: ChildSessionSpec["effectiveTools"];
  readonly skillRefs: ChildSessionSpec["skillRefs"];
  readonly extensionRefs: ChildSessionSpec["extensionRefs"];
  readonly inheritProjectContext: ChildSessionSpec["inheritProjectContext"];
  readonly timeoutMs: ChildSessionSpec["timeoutMs"];
  readonly turnBudget: ChildSessionSpec["turnBudget"];
  readonly toolBudget: ChildSessionSpec["toolBudget"];
}

/** Passive policy data interpreted by an AcceptanceEngine. */
export interface AcceptancePlan<TOutput> {
  readonly kind: string;
  readonly returns: ReturnSpec<TOutput>;
  readonly data?: unknown;
}

/** One canonical application-level execution plan. */
export interface SubagentExecutionPlan<TOutput> {
  readonly assignment: {
    readonly task: string;
    readonly requirements: readonly string[];
  };

  readonly session: {
    readonly options?: SubagentSessionOptions;
    readonly defaults: SubagentSessionDefaults;
  };

  readonly runtime: RuntimeBindings;
  readonly acceptance: AcceptancePlan<TOutput>;
}

/** Compile the stable public request into one passive execution plan. */
export interface SubagentExecutionCompiler {
  compile<TOutput>(
    request: import("./subagent-api.ts").SubagentRequest<TOutput>,
    signal: AbortSignal,
  ): Promise<SubagentExecutionPlan<TOutput>>;
}

/** Execute acceptance policy independently from child-session construction. */
export interface AcceptanceEngine {
  evaluate<TOutput>(
    plan: AcceptancePlan<TOutput>,
    run: ChildRun,
    signal: AbortSignal,
  ): Promise<TOutput>;
}
