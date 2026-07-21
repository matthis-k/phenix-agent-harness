import type { Difficulty, TaskProfile } from "@matthis-k/phenix-kernel/task.ts";
import { deriveTaskProfileFromText, difficultyForProfile } from "@matthis-k/phenix-kernel/task.ts";
import { modelSetForModelId } from "@matthis-k/phenix-routing/provider.ts";
import { modelRegistry } from "@matthis-k/phenix-routing/registry.ts";
import {
  type ModelRegistry as RoutingModelRegistry,
  resolveRoute,
} from "@matthis-k/phenix-routing/resolver.ts";
import { getSessionRuntime } from "@matthis-k/phenix-routing/state.ts";
import {
  clearActiveRouteForSession,
  setActiveRouteForSession,
} from "@matthis-k/phenix-routing/stream-proxy.ts";
import type { ResolvedRoute, RoutingConfig } from "@matthis-k/phenix-routing/types.ts";
import {
  difficultyForWorkflow,
  selectWorkflow,
  type WorkflowSelection,
} from "./workflow-selection.ts";

export interface SelectedRootModel {
  readonly provider: string;
  readonly id: string;
}

export interface RootWorkflowEntry {
  readonly profile: TaskProfile;
  readonly difficulty: Difficulty;
  readonly route: ResolvedRoute;
  readonly workflow: WorkflowSelection;
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
 * Resolve the workflow preset and coordinator route for one root turn.
 *
 * Intent selects the workflow graph while task profile selects its difficulty.
 * The two decisions are independent so a full QA request cannot accidentally
 * enter the D0 implementation graph merely because its wording is short.
 */
export async function prepareRootWorkflowEntry(
  input: {
    readonly sessionId: string;
    readonly selectedModel: SelectedRootModel;
    readonly userMessage: string;
    readonly config: RoutingConfig;
    readonly fallbackWorkflowDefinitionId: string;
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
  const workflow = selectWorkflow({
    userMessage: input.userMessage,
    fallbackWorkflowDefinitionId: input.fallbackWorkflowDefinitionId,
  });
  const difficulty = difficultyForWorkflow({
    selected: difficultyForProfile(profile),
    workflow,
    userMessage: input.userMessage,
  });
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
  return { profile, difficulty, route, workflow };
}
