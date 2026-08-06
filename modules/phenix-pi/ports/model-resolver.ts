import type {
  ModelResolutionContext,
  ModelSelector,
  ModelTarget,
  ResolvedModel,
} from "../domain/definition/model.ts";

export interface ModelResolver {
  resolve(selector: ModelSelector, context: ModelResolutionContext): Promise<ResolvedModel>;
}

export interface ModelInventory {
  available(): readonly ModelTarget[];
  contains(target: ModelTarget): boolean;
}
