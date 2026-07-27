import { DefinitionCatalog, WorkflowFunctionRegistry } from "../application/catalog.ts";
import { DynamicWorkflowCompiler } from "../application/dynamic-workflow-compiler.ts";
import { DynamicWorkflowRuntimeRegistry } from "../application/dynamic-workflow-runtime.ts";
import { agentDefinitions } from "../definitions/agents.ts";
import { resolveDefinitionSchema } from "../definitions/schema-registry.ts";
import { registerWorkflowFunctions } from "../definitions/workflows/functions.ts";
import { workflowDefinitions } from "../definitions/workflows/index.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";

export interface DefinitionRuntime {
  readonly functions: WorkflowFunctionRegistry;
  readonly definitions: DefinitionCatalog;
  readonly dynamicRegistry: DynamicWorkflowRuntimeRegistry;
}

export function createDefinitionRuntime(operations: LocalOperationRunner): DefinitionRuntime {
  const functions = new WorkflowFunctionRegistry();
  registerWorkflowFunctions(functions);

  const definitions = new DefinitionCatalog();
  for (const definition of [...agentDefinitions, ...workflowDefinitions]) {
    definitions.register(definition);
  }
  definitions.seal(functions, operations);

  const dynamicRegistry = new DynamicWorkflowRuntimeRegistry({
    compiler: new DynamicWorkflowCompiler({
      resolveDefinition: (id) => definitions.require(id),
      resolveSchema: resolveDefinitionSchema,
    }),
    catalog: definitions,
    functions,
  });

  return { functions, definitions, dynamicRegistry };
}
