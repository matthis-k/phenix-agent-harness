import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type {
  PiSessionFactory,
  PiSessionLike,
  PreparedPiSessionSpec,
} from "./sdk-child-session-backend.ts";
import { ProductionPiSessionFactory } from "./sdk-child-session-backend.ts";

const RETIRED_DELEGATION_TOOLS = new Set(["phenix_create_subagent", "phenix_delegate", "subagent"]);

/** Normalize the final child tool list immediately before Pi session creation. */
export function normalizeWorkflowRuntimeToolNames(tools: readonly string[]): readonly string[] {
  const retained = tools.filter((tool) => !RETIRED_DELEGATION_TOOLS.has(tool));
  return [...new Set([...retained, "phenix_complete", "phenix_workflow"])].sort();
}

function normalizeCustomTools(tools: readonly ToolDefinition[]): readonly ToolDefinition[] {
  return tools.filter((tool) => !RETIRED_DELEGATION_TOOLS.has(tool.name));
}

/**
 * Final SDK boundary for contract-bound children.
 *
 * Lower-level policy code may still encounter retired names while old persisted
 * contracts are read. They never cross this boundary into a live Pi session.
 */
export class WorkflowScopedPiSessionFactory implements PiSessionFactory {
  private readonly delegate: PiSessionFactory;

  constructor(delegate: PiSessionFactory = new ProductionPiSessionFactory()) {
    this.delegate = delegate;
  }

  create(spec: PreparedPiSessionSpec): Promise<PiSessionLike> {
    return this.delegate.create({
      ...spec,
      tools: normalizeWorkflowRuntimeToolNames(spec.tools),
      customTools: normalizeCustomTools(spec.customTools),
    });
  }
}
