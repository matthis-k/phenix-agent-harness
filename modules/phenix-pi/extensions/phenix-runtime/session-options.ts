/**
 * session-options — declarative child-session request vocabulary
 *
 * A caller describes the desired session without resolving a concrete model
 * eagerly. Routed selectors are resolved at the runtime boundary through an
 * optional injected resolver. Concrete selectors require no routing service or
 * routing defaults, keeping the generic child-session API backend-neutral.
 */

import type { AgentRole } from "../phenix-kernel/agents.ts";
import type { ModelSetId } from "../phenix-kernel/ids.ts";
import type { Difficulty, ThinkingLevel } from "../phenix-kernel/task.ts";
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

/**
 * Scope defaults supplied by a workflow or standalone composition root.
 *
 * `modelSet` and `difficulty` are needed only when a routed model is selected.
 * A concrete-model caller can omit both and avoid linking routing entirely.
 */
export interface SubagentSessionDefaults {
  readonly agent: AgentRole;
  readonly modelSet?: ModelSetId;
  readonly difficulty?: Difficulty;
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

function concreteModel(provider: string, id: string): ConcreteSessionModel {
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

  concrete: concreteModel,
});

function selectedAgent(requested: AgentRole | undefined, fallback: AgentRole): AgentRole {
  return requested === undefined ? fallback : requested;
}

function validateConcreteSelector(selector: ConcreteSessionModel): void {
  concreteModel(selector.model.provider, selector.model.id);
}

function requireRouteValue<T>(value: T | undefined, name: string): T {
  if (value !== undefined) return value;
  throw new Error(
    `Cannot resolve routed subagent model: ${name} is not configured. ` +
      "Provide it through routing.get(...), the session defaults, or select routing.concrete(...).",
  );
}

/**
 * Resolve declarative session options into the concrete values consumed by a
 * ChildSessionSpec.
 *
 * Workflow composition can inject the canonical Phenix routing table. A
 * standalone caller selecting a concrete model needs neither a route resolver
 * nor model-set/difficulty defaults.
 */
export async function resolveSubagentSessionOptions(input: {
  readonly session?: SubagentSessionOptions;
  readonly defaults: SubagentSessionDefaults;
  readonly resolveRoute?: SessionRouteResolver;
}): Promise<ResolvedSubagentSessionOptions> {
  const session = input.session ?? {};
  const agent = selectedAgent(session.agent, input.defaults.agent);
  const persistence = session.persistence ?? input.defaults.persistence;
  const modelSelector = session.model ?? routing.get();

  if (modelSelector.kind === "concrete") {
    validateConcreteSelector(modelSelector);
    return {
      agent,
      model: modelSelector.model,
      thinking: session.thinking ?? input.defaults.thinking,
      persistence,
    };
  }

  if (!input.resolveRoute) {
    throw new Error(
      "Cannot resolve routed subagent model: no session route resolver is configured. " +
        "Inject a resolver or select routing.concrete(provider, id).",
    );
  }

  const route: SessionRouteRequest = {
    modelSet: requireRouteValue(
      modelSelector.modelSet ?? input.defaults.modelSet,
      "model set",
    ),
    agent: selectedAgent(modelSelector.agent, agent),
    difficulty: requireRouteValue(
      modelSelector.difficulty ?? input.defaults.difficulty,
      "difficulty",
    ),
  };
  const resolution = await input.resolveRoute(route);
  validateConcreteSelector({ kind: "concrete", model: resolution.model });

  return {
    agent,
    model: resolution.model,
    thinking: session.thinking ?? resolution.thinking,
    persistence,
    route,
  };
}
