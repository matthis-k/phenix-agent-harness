import type { TaskProfile, Difficulty } from "../phenix-kernel/task.ts";
import { deriveTaskProfileFromText, difficultyForProfile } from "../phenix-kernel/task.ts";
import { modelSetForModelId } from "../phenix-routing/provider.ts";
import { modelRegistry } from "../phenix-routing/registry.ts";
import {
  type ModelRegistry as RoutingModelRegistry,
  resolveRoute,
} from "../phenix-routing/resolver.ts";
import { getSessionRuntime } from "../phenix-routing/state.ts";
import {
  clearActiveRouteForSession,
  setActiveRouteForSession,
} from "../phenix-routing/stream-proxy.ts";
import type { ResolvedRoute, RoutingConfig } from "../phenix-routing/types.ts";

export interface SelectedRootModel {
  readonly provider: string;
  readonly id: string;
}

export interface RootWorkflowEntry {
  readonly profile: TaskProfile;
  readonly difficulty: Difficulty;
  readonly route: ResolvedRoute;
}

export interface RootWorkflowEntryDependencies {
  readonly modelRegistry: RoutingModelRegistry;
  readonly resolveRoute: typeof resolveRoute;
  readonly getSessionRuntime: typeof getSessionRuntime;
  readonly clearActiveRouteForSession: typeof clearActiveRouteForSession;
  readonly setActiveRouteForSession: typeof setActiveRouteForSession;
}

const DEFAULT_DEPENDENCIES: RootWorkflowEntryDependencies = {
  modelRegistry,
  resolveRoute,
  getSessionRuntime,
  clearActiveRouteForSession,
  setActiveRouteForSession,
};

/**
 * Resolve and publish the coordinator route that authorizes a root workflow turn.
 *
 * This is the only legal entry path from a virtual `phenix/<model-set>` model to
 * a concrete provider model. Difficulty is derived before any model request and
 * the previous route is invalidated before the new turn is resolved.
 */
export async function prepareRootWorkflowEntry(
  input: {
    readonly sessionId: string;
    readonly selectedModel: SelectedRootModel;
    readonly userMessage: string;
    readonly config: RoutingConfig;
  },
  overrides: Partial<RootWorkflowEntryDependencies> = {},
): Promise<RootWorkflowEntry> {
  const dependencies: RootWorkflowEntryDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...overrides,
  };
  const runtime = dependencies.getSessionRuntime(input.sessionId);

  runtime.activeRoute = null;
  dependencies.clearActiveRouteForSession(input.sessionId);

  if (input.selectedModel.provider === "phenix") {
    const explicitModelSet = modelSetForModelId(input.selectedModel.id);
    if (!explicitModelSet) {
      throw new Error(`Unknown Phenix root model "${input.selectedModel.id}".`);
    }
    runtime.modelSet = explicitModelSet;
  }

  const profile = deriveTaskProfileFromText(input.userMessage, []);
  const difficulty = difficultyForProfile(profile);
  const route = await dependencies.resolveRoute({
    modelSet: runtime.modelSet,
    role: "coordinator",
    difficulty,
    modelRegistry: dependencies.modelRegistry,
    config: input.config,
  });

  if (
    route.modelSet !== runtime.modelSet ||
    route.role !== "coordinator" ||
    route.difficulty !== difficulty
  ) {
    throw new Error(
      `Invalid root workflow entry route: expected ${runtime.modelSet}/coordinator/${difficulty}, ` +
        `received ${route.modelSet}/${route.role}/${route.difficulty}.`,
    );
  }

  runtime.activeRoute = route;
  dependencies.setActiveRouteForSession(input.sessionId, route);
  return { profile, difficulty, route };
}
