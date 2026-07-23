import type {
  ModelResolutionContext,
  ModelSelector,
  ResolvedModel,
} from "../domain/definition/model.ts";

export interface ModelResolver {
  resolve(selector: ModelSelector, context: ModelResolutionContext): Promise<ResolvedModel>;
}

export interface ModelInventory {
  available(): readonly { readonly provider: string; readonly model: string }[];
  contains(provider: string, model: string): boolean;
}
