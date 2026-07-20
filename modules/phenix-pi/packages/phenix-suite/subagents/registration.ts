import type { WorkflowTurnGate } from "../composition/workflow-turn-gate.ts";
import type { PhenixSubagentFacade } from "./facade.ts";

/** Public registration dependencies; concrete delegation/store internals stay behind facades. */
export interface PhenixSubagentsOptions {
  readonly facade: PhenixSubagentFacade;
  readonly workflowGate: WorkflowTurnGate;
}
