import type {
  PureConditionRef,
  PureDecisionRef,
  ValueMappingRef,
} from "../definition/definition.ts";
import type { WorkflowEvaluationContext } from "./graph-state.ts";

export type ValueMapping = (context: WorkflowEvaluationContext) => unknown;
export type PureDecision = (context: WorkflowEvaluationContext) => unknown;
export type PureCondition = (context: WorkflowEvaluationContext, decision: unknown) => boolean;

export interface WorkflowFunctionRegistrar {
  registerMapping(ref: ValueMappingRef, mapping: ValueMapping): void;
  registerDecision(ref: PureDecisionRef, decision: PureDecision): void;
  registerCondition(ref: PureConditionRef, condition: PureCondition): void;
}
