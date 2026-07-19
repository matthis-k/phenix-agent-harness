import type { WorkflowRuntimePort } from "../runtime/workflow-runtime-types.ts";
import type { WorkflowDelegator } from "./workflow-delegator.ts";

/** Passive inputs required by the Pi subagent registration implementation. */
export interface PhenixSubagentsOptions {
  readonly delegator: WorkflowDelegator;
  readonly workflow: WorkflowRuntimePort;
}
