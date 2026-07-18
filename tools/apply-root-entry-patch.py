from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"expected patch context missing in {path}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "modules/phenix-pi/extensions/phenix-composition/root-workflow-integration.ts",
    '''import {
  type Difficulty,
  deriveTaskProfileFromText,
  difficultyForProfile,
  type TaskProfile,
} from "../phenix-kernel/task.ts";
import { loadRoutingConfig, validateConfig } from "../phenix-routing/config.ts";
import { modelSetForModelId } from "../phenix-routing/provider.ts";
import { modelRegistry } from "../phenix-routing/registry.ts";
import { resolveRoute } from "../phenix-routing/resolver.ts";
import { extractRootTurnInput } from "../phenix-routing/root-turn.ts";
import { getSessionRuntime } from "../phenix-routing/state.ts";
import { setActiveRouteForSession } from "../phenix-routing/stream-proxy.ts";
''',
    '''import type { Difficulty, TaskProfile } from "../phenix-kernel/task.ts";
import { loadRoutingConfig, validateConfig } from "../phenix-routing/config.ts";
import { modelRegistry } from "../phenix-routing/registry.ts";
import { extractRootTurnInput } from "../phenix-routing/root-turn.ts";
import { getSessionRuntime } from "../phenix-routing/state.ts";
''',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-composition/root-workflow-integration.ts",
    'import { phenixRootModelScope } from "./model-scope.ts";\n',
    'import { phenixRootModelScope } from "./model-scope.ts";\nimport { prepareRootWorkflowEntry } from "./root-workflow-entry.ts";\n',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-composition/root-workflow-integration.ts",
    '''    const profile = deriveTaskProfileFromText(turn.userMessage, []);
    const difficulty = difficultyForProfile(profile);
    const isNewTurn = runtime.currentTurnId !== turn.turnId;
    if (isNewTurn) runtime.currentTurnId = turn.turnId;

    const cwd = ctx.cwd;
    const artifact = runtime.capabilityArtifact as AgentCapabilityArtifact | undefined;
    if (!artifact) {
      throw new Error(
        "Cannot initialize the Phenix workflow: agent capability discovery did not complete.",
      );
    }

    const explicitModelSet = modelSetForModelId(selectedModel.id);
    if (explicitModelSet) runtime.modelSet = explicitModelSet;

    const route = await resolveRoute({
      modelSet: runtime.modelSet,
      role: "coordinator",
      difficulty,
      modelRegistry,
      config,
    });
    if (route.difficulty !== difficulty) {
      throw new Error(
        `Coordinator route difficulty mismatch: workflow=${difficulty}, route=${route.difficulty}`,
      );
    }

    runtime.activeRoute = route;
    setActiveRouteForSession(sessionId, route);
''',
    '''    const isNewTurn = runtime.currentTurnId !== turn.turnId;
    if (isNewTurn) runtime.currentTurnId = turn.turnId;

    const cwd = ctx.cwd;
    const artifact = runtime.capabilityArtifact as AgentCapabilityArtifact | undefined;
    if (!artifact) {
      throw new Error(
        "Cannot initialize the Phenix workflow: agent capability discovery did not complete.",
      );
    }

    const { profile, difficulty } = await prepareRootWorkflowEntry({
      sessionId,
      selectedModel,
      userMessage: turn.userMessage,
      config,
    });
''',
)

replace_once(
    "modules/phenix-pi/extensions/phenix-routing/resolver.ts",
    'import { difficultyForProfile } from "./classifier.ts";\n',
    '',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-routing/resolver.ts",
    '''  readonly difficulty?: Difficulty;
  readonly profile?: {
    readonly complexity: number;
    readonly uncertainty: number;
    readonly consequence: number;
    readonly breadth: number;
    readonly coupling: number;
    readonly novelty: number;
  };
''',
    '''  readonly difficulty: Difficulty;
''',
)
replace_once(
    "modules/phenix-pi/extensions/phenix-routing/resolver.ts",
    '''  // 1. Determine difficulty
  let difficulty: Difficulty;
  if (input.difficulty) {
    difficulty = input.difficulty;
  } else if (input.profile) {
    difficulty = difficultyForProfile(input.profile);
  } else {
    difficulty = "D1";
  }
''',
    '''  // 1. Difficulty is workflow-owned and must be resolved before routing.
  const difficulty = input.difficulty;
''',
)

replace_once(
    "modules/phenix-pi/extensions/phenix-routing/stream-proxy.ts",
    '''  let route = getActiveRouteForSession(sessionId);

  if (!route || route.modelSet !== requestedModelSet) {
    route = await dependencies.resolveRoute({
      modelSet: requestedModelSet,
      role: "coordinator",
      modelRegistry: dependencies.modelRegistry,
      config,
    });
    setActiveRouteForSession(sessionId, route);
  }
''',
    '''  const route = getActiveRouteForSession(sessionId);
  if (!route) {
    throw new Error(
      `Phenix workflow entry route is missing for session "${sessionId}". ` +
        "The before_agent_start workflow bootstrap must derive difficulty and install " +
        "the coordinator route before provider streaming begins.",
    );
  }
  if (route.modelSet !== requestedModelSet) {
    throw new Error(
      `Phenix workflow entry route targets model set "${route.modelSet}", ` +
        `but the selected virtual model requires "${requestedModelSet}".`,
    );
  }
''',
)

replace_once(
    "modules/phenix-pi/tests/routing-stream-failover.test.ts",
    '''  clearActiveRouteForSession,
  createRouterStream,
''',
    '''  clearActiveRouteForSession,
  createRouterStream,
  setActiveRouteForSession,
''',
)
replace_once(
    "modules/phenix-pi/tests/routing-stream-failover.test.ts",
    '''function assertVirtualIdentity(events: readonly AssistantMessageEvent[]): void {
  for (const event of events) {
    const publicMessage =
      event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
    assert.equal(publicMessage.provider, "phenix");
    assert.equal(publicMessage.model, "free");
  }
}
''',
    '''function assertVirtualIdentity(events: readonly AssistantMessageEvent[]): void {
  for (const event of events) {
    const publicMessage =
      event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
    assert.equal(publicMessage.provider, "phenix");
    assert.equal(publicMessage.model, "free");
  }
}

function primeEntryRoute(sessionId: string, candidates: readonly Model<Api>[]): void {
  const refs = candidates.map((model) => ({ provider: model.provider, model: model.id }));
  const first = refs[0];
  if (!first) throw new Error("Cannot prime an empty route");
  setActiveRouteForSession(sessionId, {
    modelSet: modelSetId("free"),
    role: "coordinator",
    difficulty: "D1",
    capability: "general",
    pool: "free.universal",
    candidates: refs,
    model: first,
    candidateIndex: 0,
    thinking: "low",
    usedAvoidedModelFallback: false,
  });
}
''',
)
replace_once(
    "modules/phenix-pi/tests/routing-stream-failover.test.ts",
    '''  clearActiveRouteForSession(sessionId);

  const events = await collect(
    createRouterStream(
      dependencies(
        [first, second],
''',
    '''  clearActiveRouteForSession(sessionId);
  primeEntryRoute(sessionId, [first, second]);

  const events = await collect(
    createRouterStream(
      dependencies(
        [first, second],
''',
)
replace_once(
    "modules/phenix-pi/tests/routing-stream-failover.test.ts",
    '''  clearActiveRouteForSession(sessionId);

  const events = await collect(
    createRouterStream(
      dependencies(candidates, (model) => failure(model, `${model.id} failed`), attempts),
''',
    '''  clearActiveRouteForSession(sessionId);
  primeEntryRoute(sessionId, candidates);

  const events = await collect(
    createRouterStream(
      dependencies(candidates, (model) => failure(model, `${model.id} failed`), attempts),
''',
)
