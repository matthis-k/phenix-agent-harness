/** Root-model activation boundary for Phenix-owned behavior. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PHENIX_PROVIDER } from "../phenix-routing/provider.ts";

export interface ModelIdentity {
  readonly provider?: string | null;
}

/**
 * Describes which directly selected root models belong to one integration.
 *
 * Child sessions do not use this scope: they are explicit Phenix actors whose
 * authority is closure-bound to an initialized contract, even when routing
 * selects a concrete model from another provider.
 */
export interface RootModelScope {
  readonly provider: string;
  readonly label: string;

  includes(model: ModelIdentity | null | undefined): model is ModelIdentity;

  contributeSystemPrompt(input: {
    readonly model: ModelIdentity | null | undefined;
    readonly systemPrompt: string;
    readonly contribution: string;
  }): string | undefined;

  denialReason(input: {
    readonly model: ModelIdentity | null | undefined;
    readonly capability: string;
  }): string | undefined;
}

export function createProviderRootModelScope(input: {
  readonly provider: string;
  readonly label: string;
}): RootModelScope {
  if (input.provider.trim().length === 0) {
    throw new Error("Root model scope provider must be non-empty.");
  }
  if (input.label.trim().length === 0) {
    throw new Error("Root model scope label must be non-empty.");
  }

  return Object.freeze({
    provider: input.provider,
    label: input.label,

    includes(model: ModelIdentity | null | undefined): model is ModelIdentity {
      return model?.provider === input.provider;
    },

    contributeSystemPrompt({ model, systemPrompt, contribution }): string | undefined {
      if (model?.provider !== input.provider) return undefined;
      if (contribution.trim().length === 0) return systemPrompt;
      return `${systemPrompt}\n\n${contribution}`;
    },

    denialReason({ model, capability }): string | undefined {
      if (model?.provider === input.provider) return undefined;
      return `${capability} is available only in ${input.label} root-model sessions.`;
    },
  });
}

export const phenixRootModelScope = createProviderRootModelScope({
  provider: PHENIX_PROVIDER,
  label: "Phenix",
});

export function authorizePhenixRootCapability(input: {
  readonly ctx: ExtensionContext;
  readonly capability: string;
}): string | undefined {
  return phenixRootModelScope.denialReason({
    model: input.ctx.model,
    capability: input.capability,
  });
}
