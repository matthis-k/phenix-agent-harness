import type { Definition, DefinitionRef } from "../domain/definition/definition.ts";
import type { DefinitionId, RunId } from "../domain/shared.ts";
import { ROOT_INTERNAL_DEFINITION_IDS } from "../definitions/ids.ts";
import type { DefinitionCatalog } from "./catalog.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { CatalogFacade, DefinitionSummary } from "./interfaces.ts";

const INTERNAL_DEFINITION_IDS = new Set<DefinitionId>(ROOT_INTERNAL_DEFINITION_IDS);

export class CatalogFacadeImpl implements CatalogFacade {
  private readonly catalog: DefinitionCatalog;
  private readonly store: ExecutionStore;

  constructor(catalog: DefinitionCatalog, store: ExecutionStore) {
    this.catalog = catalog;
    this.store = store;
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
        (definition) => allowed.has(definition.id) && !INTERNAL_DEFINITION_IDS.has(definition.id),
      )
      .map((definition) => ({
        id: definition.id,
        kind: definition.kind,
        title: definition.title,
        description: definition.description,
      }));
  }

  validateAll() {
    return this.catalog.validateAll();
  }
}
