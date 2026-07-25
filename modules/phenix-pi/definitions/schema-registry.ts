import type { Schema } from "../domain/definition/schema.ts";
import { AttentionRoutingDecisionSchema, AttentionRoutingRequestSchema } from "./attention.ts";
import { DifficultyAssessmentRequestSchema, DifficultyAssessmentSchema } from "./difficulty.ts";
import { DispatchDecisionSchema, DispatchSelectionRequestSchema } from "./dispatch.ts";
import { DynamicWorkflowProposalSchema } from "./dynamic-workflow.ts";
import {
  BaseResultSchema,
  ChangeSetSchema,
  CriticReportSchema,
  CriticRequestSchema,
  FinalReportSchema,
  ImplementationRequestSchema,
  ImplementationResultSchema,
  ObjectiveRequestSchema,
  PlanRequestSchema,
  PlanResultSchema,
  QAReportSchema,
  QASynthesisRequestSchema,
  ScoutReportSchema,
  ScoutRequestSchema,
  TestReportSchema,
  TestRequestSchema,
  VerificationRequestSchema,
  VerificationResultSchema,
} from "./schemas.ts";
import { CheckResultsSchema, QAChecksRequestSchema } from "./workflow-schemas.ts";

export const definitionSchemas = [
  ObjectiveRequestSchema,
  DifficultyAssessmentRequestSchema,
  DifficultyAssessmentSchema,
  ScoutRequestSchema,
  ScoutReportSchema,
  PlanRequestSchema,
  PlanResultSchema,
  ImplementationRequestSchema,
  ChangeSetSchema,
  TestRequestSchema,
  TestReportSchema,
  VerificationRequestSchema,
  VerificationResultSchema,
  CriticRequestSchema,
  CriticReportSchema,
  BaseResultSchema,
  QASynthesisRequestSchema,
  QAReportSchema,
  ImplementationResultSchema,
  FinalReportSchema,
  DispatchSelectionRequestSchema,
  DispatchDecisionSchema,
  DynamicWorkflowProposalSchema,
  AttentionRoutingRequestSchema,
  AttentionRoutingDecisionSchema,
  QAChecksRequestSchema,
  CheckResultsSchema,
] as const;

const schemaById = new Map<string, Schema<unknown>>();
for (const schema of definitionSchemas) {
  if (schemaById.has(schema.id)) throw new Error(`Duplicate definition schema ${schema.id}`);
  schemaById.set(schema.id, schema as Schema<unknown>);
}

export function resolveDefinitionSchema(id: string): Schema<unknown> {
  const schema = schemaById.get(id);
  if (!schema) throw new Error(`Unknown definition schema ${id}`);
  return schema;
}
