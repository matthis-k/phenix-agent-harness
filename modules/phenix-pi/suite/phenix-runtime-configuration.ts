import { ProfileAwareModelResolver } from "../application/profile-aware-model-resolver.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import {
  ALL_DEFINITION_IDS,
  ROOT_DISPATCH_DEFINITION_IDS,
  ROOT_INTERNAL_DEFINITION_IDS,
} from "../definitions/ids.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { PolicyModelResolver } from "../framework/routing/policy-model-resolver.ts";
import { defineRuntimeConfiguration } from "../framework/runtime-configuration.ts";
import { phenixBudgetPolicy } from "./phenix-budget-policy.ts";
import { defaultRoutingPolicy } from "./phenix-routing-policy.ts";

export const phenixRuntimeConfiguration = defineRuntimeConfiguration({
  budgetPolicy: phenixBudgetPolicy,
  catalog: {
    definitionIds: ALL_DEFINITION_IDS,
    definitions: [...agentDefinitions, ...workflowDefinitions],
    registerWorkflowFunctions,
    resolveDefinitionSchema,
    rootInvokableDefinitions: [...ROOT_DISPATCH_DEFINITION_IDS, ...ROOT_INTERNAL_DEFINITION_IDS],
    hiddenDefinitions: ROOT_INTERNAL_DEFINITION_IDS,
  },
  createModelResolver({ inventory, currentProfile }) {
    const backend = new PolicyModelResolver(inventory, defaultRoutingPolicy);
    return new ProfileAwareModelResolver(backend, currentProfile);
  },
});

export type PhenixRuntimeConfiguration = typeof phenixRuntimeConfiguration;
