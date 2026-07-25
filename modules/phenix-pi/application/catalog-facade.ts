import type { Definition, DefinitionRef } from "../domain/definition/definition.ts";
import type { DefinitionId, RunId } from "../domain/shared.ts";
import type { DefinitionCatalog } from "./catalog.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { CatalogFacade, DefinitionSummary } from "./interfaces.ts";

export class CatalogFacadeImpl implements CatalogFacade {
  private readonly catalog: DefinitionCatalog;
  private readonly store: ExecutionStore;
  private readonly hiddenDefinitions: ReadonlySet<DefinitionId>;

  constructor(
    catalog: DefinitionCatalog,
    store: ExecutionStore,
    options: { readonly hiddenDefinitions?: readonly DefinitionId[] } = {},
  ) {
    this.catalog = catalog;
    this.store = store;
    this.hiddenDefinitions = new Set(options.hiddenDefinitions ?? []);
  }

  get<I, O>(ref: DefinitionRef<I, O>): Definition<I, O> {
    return this.catalog.get(ref);
  }

  async listAvailable(parentId: RunId): Promise<readonly DefinitionSummary[]> {
    const parent = this.store.projection.requireRun(parentId);
    if (parent.kind === "workflow") return [];
    const allowed = new Set(parent.compiled.capabilities.invokableDefinitions);
    return this.catalog
      .list()
      .filter(
        (definition) => allowed.has(definition.id) && !this.hiddenDefinitions.has(definition.id),
      )
      .map((definition) => ({
        id: definition.id,
        kind:
          definition.kind === "agent" && definition.sessionMode === "stock"
            ? ("session" as const)
            : definition.kind,
        title: definition.title,
        description: definition.description,
        inputSchema: definition.input.id,
        outputSchema:
          definition.kind === "agent" && definition.sessionMode === "stock"
            ? "dynamic"
            : definition.output.id,
      }));
  }

  validateAll() {
    return this.catalog.validateAll();
  }
}
