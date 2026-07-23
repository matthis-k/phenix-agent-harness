import type { ModelResolutionContext, ModelSelector, ResolvedModel } from "../domain/definition/model.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import type { ModelResolver } from "../ports/model-resolver.ts";

export class ProfileAwareModelResolver implements ModelResolver {
  private readonly delegate: ModelResolver;
  private readonly profile: () => Promise<SessionProfile>;

  constructor(delegate: ModelResolver, profile: () => Promise<SessionProfile>) {
    this.delegate = delegate;
    this.profile = profile;
  }

  async resolve(selector: ModelSelector, context: ModelResolutionContext): Promise<ResolvedModel> {
    const profile = await this.profile();
    return this.delegate.resolve(selector, {
      ...context,
      modelSet: context.modelSet ?? profile.modelSet,
      difficulty: context.difficulty ?? profile.difficulty,
    });
  }
}
