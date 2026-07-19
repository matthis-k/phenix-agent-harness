/**
 * session-options — declarative child-session request vocabulary
 *
 * A caller describes the desired session without resolving a concrete model
 * eagerly. Routed selectors are resolved at the runtime boundary through an
 * injected resolver, so workflow routing remains optional rather than a hard
 * dependency of the generic child-session API.
 */

import type { AgentRole } from "@matthis-k/phenix-kernel/agents.ts";
import type { ModelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import type { Difficulty, ThinkingLevel } from "@matthis-k/phenix-kernel/task.ts";
import type { ConcreteModelRef } from "./child-session-types.ts";

export type SessionPersistence = "memory" | "file";

export interface RoutedSessionModel {
  readonly kind: "route";
  readonly agent?: AgentRole;
  readonly modelSet?: ModelSetId;
  readonly difficulty?: Difficulty;
}

export interface ConcreteSessionModel {
  readonly kind: "concrete";
  readonly model: ConcreteModelRef;
}

export type SessionModelSelector = RoutedSessionModel | ConcreteSessionModel;

/**
 * User-facing options for one child Pi session.
 *
 * Omitting `model` requests late-bound routing. Omitting `thinking` adopts the
 * routed thinking level for routed models, or the caller-provided default for
 * a concrete model.
 */
export interface SubagentSessionOptions {
  readonly agent?: AgentRole;
  readonly model?: SessionModelSelector;
  readonly thinking?: ThinkingLevel;
  readonly persistence?: SessionPersistence;
}

export interface SubagentSessionDefaults {
  readonly agent: AgentRole;
  readonly modelSet: ModelSetId;
  readonly difficulty: Difficulty;
  readonly thinking: ThinkingLevel;
  readonly persistence: SessionPersistence;
}

export interface SessionRouteRequest {
  readonly modelSet: ModelSetId;
  readonly agent: AgentRole;
  readonly difficulty: Difficulty;
}

export interface SessionRouteResolution {
  readonly model: ConcreteModelRef;
  readonly thinking: ThinkingLevel;
}

export type SessionRouteResolver = (
  request: SessionRouteRequest,
) => Promise<SessionRouteResolution>;

export interface ResolvedSubagentSessionOptions {
  readonly agent: AgentRole;
  readonly model: ConcreteModelRef;
  readonly thinking: ThinkingLevel;
  readonly persistence: SessionPersistence;
  readonly route?: SessionRouteRequest;
}

export interface RoutedSessionModelOptions {
  readonly modelSet?: ModelSetId;
  readonly difficulty?: Difficulty;
}

/** Declarative model-selector constructors for session options. */
export const routing = Object.freeze({
  get(agent?: AgentRole, options: RoutedSessionModelOptions = {}): RoutedSessionModel {
    return {
      kind: "route",
      ...(agent !== undefined ? { agent } : {}),
      ...(options.modelSet !== undefined ? { modelSet: options.modelSet } : {}),
      ...(options.difficulty !== undefined ? { difficulty: options.difficulty } : {}),
    };
  },

  concrete(provider: string, id: string): ConcreteSessionModel {
    if (provider.trim().length === 0) {
      throw new Error("Concrete session model provider must be non-empty.");
    }
    if (id.trim().length === 0) {
      throw new Error("Concrete session model ID must be non-empty.");
    }
    return {
      kind: "concrete",
      model: { provider, id },
    };
  },
});

function selectedAgent(requested: AgentRole | undefined, fallback: AgentRole): AgentRole {
  return requested === undefined ? fallback : requested;
}

/**
 * Resolve declarative session options into the concrete values consumed by a
 * ChildSessionSpec.
 *
 * Routing is supplied as a port. Workflow composition can pass the canonical
 * Phenix routing table while standalone callers can provide another resolver
 * or select a concrete model and avoid routing entirely.
 */
export async function resolveSubagentSessionOptions(input: {
  readonly session?: SubagentSessionOptions;
  readonly defaults: SubagentSessionDefaults;
  readonly resolveRoute: SessionRouteResolver;
}): Promise<ResolvedSubagentSessionOptions> {
  const session = input.session ?? {};
  const agent = selectedAgent(session.agent, input.defaults.agent);
  const persistence = session.persistence ?? input.defaults.persistence;
  const modelSelector = session.model ?? routing.get();

  if (modelSelector.kind === "concrete") {
    return {
      agent,
      model: modelSelector.model,
      thinking: session.thinking ?? input.defaults.thinking,
      persistence,
    };
  }

  const route: SessionRouteRequest = {
    modelSet: modelSelector.modelSet ?? input.defaults.modelSet,
    agent: selectedAgent(modelSelector.agent, agent),
    difficulty: modelSelector.difficulty ?? input.defaults.difficulty,
  };
  const resolution = await input.resolveRoute(route);

  return {
    agent,
    model: resolution.model,
    thinking: session.thinking ?? resolution.thinking,
    persistence,
    route,
  };
}
