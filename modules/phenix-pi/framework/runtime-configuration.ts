import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

import type { AnyDefinition } from "../domain/definition/definition.ts";
import type { Schema } from "../domain/definition/schema.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import type { DefinitionId } from "../domain/shared.ts";
import type { WorkflowFunctionRegistrar } from "../domain/workflow/functions.ts";
import type { ModelResolver } from "../ports/model-resolver.ts";

export interface RuntimeCatalogConfiguration {
  readonly definitions: readonly AnyDefinition[];
  registerWorkflowFunctions(registry: WorkflowFunctionRegistrar): void;
  resolveDefinitionSchema(id: string): Schema<unknown>;
  readonly rootInvokableDefinitions: readonly DefinitionId[];
  readonly hiddenDefinitions: readonly DefinitionId[];
}

export interface RuntimeResolverDependencies {
  readonly modelRegistry: ModelRegistry;
  readonly currentProfile: () => Promise<SessionProfile>;
}

export interface RuntimeConfiguration {
  readonly catalog: RuntimeCatalogConfiguration;
  createModelResolver(dependencies: RuntimeResolverDependencies): ModelResolver;
}

export function defineRuntimeConfiguration(
  configuration: RuntimeConfiguration,
): RuntimeConfiguration {
  const definitions = [...configuration.catalog.definitions];
  const rootInvokableDefinitions = [...configuration.catalog.rootInvokableDefinitions];
  const hiddenDefinitions = [...configuration.catalog.hiddenDefinitions];
  const known = new Set<string>();

  for (const definition of definitions) {
    if (known.has(definition.id)) {
      throw new Error(`Duplicate runtime definition: ${definition.id}`);
    }
    known.add(definition.id);
  }
  for (const id of rootInvokableDefinitions) {
    if (!known.has(id)) throw new Error(`Unknown root-invokable definition: ${id}`);
  }
  const rootVisible = new Set<string>(rootInvokableDefinitions);
  for (const id of hiddenDefinitions) {
    if (!known.has(id)) throw new Error(`Unknown hidden definition: ${id}`);
    if (!rootVisible.has(id)) {
      throw new Error(`Hidden definition must also be root-invokable: ${id}`);
    }
  }

  return Object.freeze({
    catalog: Object.freeze({
      definitions: Object.freeze(definitions),
      registerWorkflowFunctions: configuration.catalog.registerWorkflowFunctions,
      resolveDefinitionSchema: configuration.catalog.resolveDefinitionSchema,
      rootInvokableDefinitions: Object.freeze(rootInvokableDefinitions),
      hiddenDefinitions: Object.freeze(hiddenDefinitions),
    }),
    createModelResolver: configuration.createModelResolver,
  });
}
