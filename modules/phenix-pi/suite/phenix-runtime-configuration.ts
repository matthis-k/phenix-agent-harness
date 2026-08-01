import { ProfileAwareModelResolver } from "../application/profile-aware-model-resolver.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { ROOT_DISPATCH_DEFINITION_IDS, ROOT_INTERNAL_DEFINITION_IDS } from "../definitions/ids.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import { PolicyModelResolver } from "../framework/routing/policy-model-resolver.ts";
import {
  defineRuntimeConfiguration,
  type RuntimeConfiguration,
} from "../framework/runtime-configuration.ts";
import { defaultRoutingPolicy } from "./phenix-routing-policy.ts";

export const phenixRuntimeConfiguration: RuntimeConfiguration = defineRuntimeConfiguration({
  catalog: {
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
