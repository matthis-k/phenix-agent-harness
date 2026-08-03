import type { AnyDefinition } from "../domain/definition/definition.ts";
import type { Schema } from "../domain/definition/schema.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import type { DefinitionId } from "../domain/shared.ts";
import type { WorkflowFunctionRegistrar } from "../domain/workflow/functions.ts";
import type { BudgetPolicy } from "../ports/budget-policy.ts";
import type { ModelInventory, ModelResolver } from "../ports/model-resolver.ts";

export interface RuntimeCatalogConfiguration<
  TDefinitionId extends DefinitionId = DefinitionId,
> {
  /**
   * The closed set of definition IDs supported by this in-repository runtime configuration.
   * Markdown and compiled definitions are runtime data and must match this declaration exactly.
   */
  readonly definitionIds: readonly TDefinitionId[];
  readonly definitions: readonly AnyDefinition[];
  registerWorkflowFunctions(registry: WorkflowFunctionRegistrar): void;
  resolveDefinitionSchema(id: string): Schema<unknown>;
  readonly rootInvokableDefinitions: readonly TDefinitionId[];
  readonly hiddenDefinitions: readonly TDefinitionId[];
}

export interface RuntimeResolverDependencies {
  readonly inventory: ModelInventory;
  readonly currentProfile: () => Promise<SessionProfile>;
}

export interface RuntimeConfiguration<TDefinitionId extends DefinitionId = DefinitionId> {
  readonly catalog: RuntimeCatalogConfiguration<TDefinitionId>;
  readonly budgetPolicy: BudgetPolicy;
  createModelResolver(dependencies: RuntimeResolverDependencies): ModelResolver;
}

export function defineRuntimeConfiguration<const TDefinitionId extends DefinitionId>(
  configuration: RuntimeConfiguration<TDefinitionId>,
): RuntimeConfiguration<TDefinitionId> {
  const definitionIds = [...configuration.catalog.definitionIds];
  const definitions = [...configuration.catalog.definitions];
  const rootInvokableDefinitions = [...configuration.catalog.rootInvokableDefinitions];
  const hiddenDefinitions = [...configuration.catalog.hiddenDefinitions];
  const declared = uniqueIds("runtime definition declaration", definitionIds);
  const compiled = new Map<string, AnyDefinition>();

  for (const definition of definitions) {
    if (compiled.has(definition.id)) {
      throw new Error(`Duplicate compiled runtime definition: ${definition.id}`);
    }
    compiled.set(definition.id, definition);
    if (!declared.has(definition.id)) {
      throw new Error(`Compiled runtime definition is not declared by the configuration: ${definition.id}`);
    }
  }
  for (const id of definitionIds) {
    if (!compiled.has(id)) {
      throw new Error(`Declared runtime definition was not compiled: ${id}`);
    }
  }

  const rootVisible = uniqueIds("root-invokable definition", rootInvokableDefinitions);
  for (const id of rootVisible) {
    if (!declared.has(id)) throw new Error(`Unknown root-invokable definition: ${id}`);
  }
  const hidden = uniqueIds("hidden definition", hiddenDefinitions);
  for (const id of hidden) {
    if (!declared.has(id)) throw new Error(`Unknown hidden definition: ${id}`);
    if (!rootVisible.has(id)) {
      throw new Error(`Hidden definition must also be root-invokable: ${id}`);
    }
  }

  return Object.freeze({
    catalog: Object.freeze({
      definitionIds: Object.freeze(definitionIds),
      definitions: Object.freeze(definitions),
      registerWorkflowFunctions: configuration.catalog.registerWorkflowFunctions,
      resolveDefinitionSchema: configuration.catalog.resolveDefinitionSchema,
      rootInvokableDefinitions: Object.freeze(rootInvokableDefinitions),
      hiddenDefinitions: Object.freeze(hiddenDefinitions),
    }),
    budgetPolicy: configuration.budgetPolicy,
    createModelResolver: configuration.createModelResolver,
  });
}

function uniqueIds<TId extends DefinitionId>(name: string, ids: readonly TId[]): ReadonlySet<TId> {
  const unique = new Set<TId>();
  for (const id of ids) {
    if (unique.has(id)) throw new Error(`Duplicate ${name}: ${id}`);
    unique.add(id);
  }
  return unique;
}
