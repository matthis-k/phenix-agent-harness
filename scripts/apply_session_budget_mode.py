from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:120]!r}")
    write(path, content.replace(old, new, 1))


write(
    "modules/phenix-pi/domain/definition/effort.ts",
    '''export const EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** User-authorized execution budget for Phenix-routed sessions. */
export type BudgetMode = EffortLevel;

export function isBudgetMode(value: string): value is BudgetMode {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function effortIndex(value: EffortLevel): number {
  return EFFORT_LEVELS.indexOf(value);
}
''',
)

replace_once(
    "modules/phenix-pi/domain/definition/model.ts",
    'export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";\n',
    'import type { BudgetMode, EffortLevel } from "./effort.ts";\n\nexport type PiThinkingLevel = EffortLevel;\n',
)
replace_once(
    "modules/phenix-pi/domain/definition/model.ts",
    '  readonly difficulty?: Difficulty;\n  readonly capability?: ModelCapability;\n',
    '  readonly difficulty?: Difficulty;\n  readonly budget?: BudgetMode;\n  readonly capability?: ModelCapability;\n',
)

replace_once(
    "modules/phenix-pi/domain/run/model.ts",
    'import type {\n  Difficulty,\n  ModelSelector,\n  PhenixModelSetId,\n  ResolvedModel,\n} from "../definition/model.ts";\n',
    'import type { BudgetMode } from "../definition/effort.ts";\nimport type {\n  Difficulty,\n  ModelSelector,\n  PhenixModelSetId,\n  ResolvedModel,\n} from "../definition/model.ts";\n',
)
replace_once(
    "modules/phenix-pi/domain/run/model.ts",
    'export interface SessionProfile {\n  readonly agent: SessionAgentPreset;\n  readonly modelSet: PhenixModelSetId;\n  readonly difficulty: Difficulty;\n}\n\nexport const DEFAULT_SESSION_PROFILE: SessionProfile = Object.freeze({\n  agent: "base",\n  modelSet: "mixed",\n  difficulty: "D1",\n});\n',
    'export interface SessionProfile {\n  readonly agent: SessionAgentPreset;\n  readonly modelSet: PhenixModelSetId;\n  readonly difficulty: Difficulty;\n  readonly budget: BudgetMode;\n}\n\nexport interface PersistedSessionProfile {\n  readonly agent: SessionAgentPreset;\n  readonly modelSet: PhenixModelSetId;\n  readonly difficulty: Difficulty;\n  readonly budget?: BudgetMode;\n}\n\nexport const DEFAULT_SESSION_PROFILE: SessionProfile = Object.freeze({\n  agent: "base",\n  modelSet: "mixed",\n  difficulty: "D1",\n  budget: "medium",\n});\n\nexport function normalizeSessionProfile(\n  profile: PersistedSessionProfile | SessionProfile | undefined,\n): SessionProfile {\n  return profile\n    ? { ...profile, budget: profile.budget ?? DEFAULT_SESSION_PROFILE.budget }\n    : DEFAULT_SESSION_PROFILE;\n}\n',
)
replace_once(
    "modules/phenix-pi/domain/run/model.ts",
    'export interface RunLimits {\n  readonly timeoutMs: number;\n',
    'export interface RunLimits {\n  readonly timeoutMs?: number;\n',
)
replace_once(
    "modules/phenix-pi/domain/run/model.ts",
    '  readonly difficulty?: Difficulty;\n  readonly limits: RunLimits;\n',
    '  readonly difficulty?: Difficulty;\n  readonly budget?: BudgetMode;\n  readonly limits: RunLimits;\n',
)

replace_once(
    "modules/phenix-pi/domain/definition/definition.ts",
    'export interface AgentLimits {\n  readonly timeoutMs: number;\n',
    'export interface AgentLimits {\n  readonly timeoutMs?: number;\n',
)

write(
    "modules/phenix-pi/ports/budget-policy.ts",
    '''import type { AgentLimits } from "../domain/definition/definition.ts";
import type { BudgetMode } from "../domain/definition/effort.ts";
import type { PiThinkingLevel } from "../domain/definition/model.ts";

export interface BudgetPolicy {
  applyAgentLimits(base: AgentLimits, budget: BudgetMode): AgentLimits;
  capThinking(requested: PiThinkingLevel, budget: BudgetMode): PiThinkingLevel;
}

export const passthroughBudgetPolicy: BudgetPolicy = Object.freeze({
  applyAgentLimits: (base) => base,
  capThinking: (requested) => requested,
});
''',
)

write(
    "modules/phenix-pi/suite/phenix-budget-policy.ts",
    '''import type { AgentLimits } from "../domain/definition/definition.ts";
import {
  effortIndex,
  type BudgetMode,
  type EffortLevel,
} from "../domain/definition/effort.ts";
import type { PiThinkingLevel } from "../domain/definition/model.ts";
import type { BudgetPolicy } from "../ports/budget-policy.ts";

interface FiniteBudget {
  readonly scale: number;
  readonly thinkingCeiling: PiThinkingLevel;
  readonly repairDelta: number;
}

const FINITE_BUDGETS: Readonly<Record<Exclude<BudgetMode, "max">, FiniteBudget>> = {
  off: { scale: 0.25, thinkingCeiling: "off", repairDelta: -10 },
  minimal: { scale: 0.5, thinkingCeiling: "minimal", repairDelta: -10 },
  low: { scale: 0.75, thinkingCeiling: "low", repairDelta: -1 },
  medium: { scale: 1, thinkingCeiling: "xhigh", repairDelta: 0 },
  high: { scale: 2, thinkingCeiling: "xhigh", repairDelta: 1 },
  xhigh: { scale: 4, thinkingCeiling: "max", repairDelta: 2 },
};

export const phenixBudgetPolicy: BudgetPolicy = Object.freeze({
  applyAgentLimits(base, budget) {
    if (budget === "max") {
      return { maxRepairAttempts: Math.min(10, Math.max(5, base.maxRepairAttempts)) };
    }

    const policy = FINITE_BUDGETS[budget];
    const timeoutMs =
      base.timeoutMs === undefined
        ? undefined
        : Math.min(3_600_000, Math.max(30_000, scaled(base.timeoutMs, policy.scale)));
    const maxTurns = scaledOptional(base.maxTurns, policy.scale);
    const maxToolCalls =
      base.maxToolCalls !== undefined
        ? scaled(base.maxToolCalls, policy.scale)
        : effortIndex(budget) <= effortIndex("low") && maxTurns !== undefined
          ? maxTurns * 6
          : undefined;
    const maxRepairAttempts = Math.min(
      10,
      Math.max(0, base.maxRepairAttempts + policy.repairDelta),
    );

    return {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      maxRepairAttempts,
    };
  },

  capThinking(requested, budget) {
    if (budget === "max") return requested;
    const ceiling = FINITE_BUDGETS[budget].thinkingCeiling;
    return effortIndex(requested as EffortLevel) <= effortIndex(ceiling as EffortLevel)
      ? requested
      : ceiling;
  },
});

function scaled(value: number, factor: number): number {
  return Math.max(1, Math.ceil(value * factor));
}

function scaledOptional(value: number | undefined, factor: number): number | undefined {
  return value === undefined ? undefined : scaled(value, factor);
}
''',
)

replace_once(
    "modules/phenix-pi/framework/runtime-configuration.ts",
    'import type { ModelInventory, ModelResolver } from "../ports/model-resolver.ts";\n',
    'import type { BudgetPolicy } from "../ports/budget-policy.ts";\nimport type { ModelInventory, ModelResolver } from "../ports/model-resolver.ts";\n',
)
replace_once(
    "modules/phenix-pi/framework/runtime-configuration.ts",
    'export interface RuntimeConfiguration {\n  readonly catalog: RuntimeCatalogConfiguration;\n  createModelResolver(dependencies: RuntimeResolverDependencies): ModelResolver;\n}\n',
    'export interface RuntimeConfiguration {\n  readonly catalog: RuntimeCatalogConfiguration;\n  readonly budgetPolicy: BudgetPolicy;\n  createModelResolver(dependencies: RuntimeResolverDependencies): ModelResolver;\n}\n',
)
replace_once(
    "modules/phenix-pi/framework/runtime-configuration.ts",
    '    createModelResolver: configuration.createModelResolver,\n',
    '    budgetPolicy: configuration.budgetPolicy,\n    createModelResolver: configuration.createModelResolver,\n',
)

replace_once(
    "modules/phenix-pi/suite/phenix-runtime-configuration.ts",
    'import { defaultRoutingPolicy } from "./phenix-routing-policy.ts";\n',
    'import { phenixBudgetPolicy } from "./phenix-budget-policy.ts";\nimport { defaultRoutingPolicy } from "./phenix-routing-policy.ts";\n',
)
replace_once(
    "modules/phenix-pi/suite/phenix-runtime-configuration.ts",
    'export const phenixRuntimeConfiguration: RuntimeConfiguration = defineRuntimeConfiguration({\n  catalog:',
    'export const phenixRuntimeConfiguration: RuntimeConfiguration = defineRuntimeConfiguration({\n  budgetPolicy: phenixBudgetPolicy,\n  catalog:',
)

replace_once(
    "modules/phenix-pi/composition/runtime-assembly.ts",
    '    models: resolver,\n    ids,\n',
    '    models: resolver,\n    budgetPolicy: configuration.budgetPolicy,\n    ids,\n',
)

replace_once(
    "modules/phenix-pi/composition/execution-kernel.ts",
    'import type { Clock, IdGenerator } from "../ports/clock.ts";\n',
    'import type { BudgetPolicy } from "../ports/budget-policy.ts";\nimport type { Clock, IdGenerator } from "../ports/clock.ts";\n',
)
replace_once(
    "modules/phenix-pi/composition/execution-kernel.ts",
    '  readonly models: ModelResolver;\n  readonly ids: IdGenerator;\n',
    '  readonly models: ModelResolver;\n  readonly budgetPolicy?: BudgetPolicy;\n  readonly ids: IdGenerator;\n',
)
replace_once(
    "modules/phenix-pi/composition/execution-kernel.ts",
    '    models,\n    ids,\n',
    '    models,\n    ids,\n',
)
replace_once(
    "modules/phenix-pi/composition/execution-kernel.ts",
    '    models,\n    ids,\n    clock,\n',
    '    models,\n    ...(input.budgetPolicy ? { budgetPolicy: input.budgetPolicy } : {}),\n    ids,\n    clock,\n',
)

replace_once(
    "modules/phenix-pi/application/execution-facade.ts",
    'import type { ModelResolver } from "../ports/model-resolver.ts";\n',
    'import type { BudgetPolicy } from "../ports/budget-policy.ts";\nimport type { ModelResolver } from "../ports/model-resolver.ts";\n',
)
replace_once(
    "modules/phenix-pi/application/execution-facade.ts",
    '    readonly models: ModelResolver;\n    readonly ids: IdGenerator;\n',
    '    readonly models: ModelResolver;\n    readonly budgetPolicy?: BudgetPolicy;\n    readonly ids: IdGenerator;\n',
)
replace_once(
    "modules/phenix-pi/application/execution-facade.ts",
    '      models: input.models,\n      rootInvokableDefinitions: this.rootInvokableDefinitions,\n',
    '      models: input.models,\n      ...(input.budgetPolicy ? { budgetPolicy: input.budgetPolicy } : {}),\n      rootInvokableDefinitions: this.rootInvokableDefinitions,\n',
)
replace_once(
    "modules/phenix-pi/application/execution-facade.ts",
    '    const definition = this.catalog.get(request.definition) as AnyDefinition;\n',
    '    const budget = root.profile?.budget ?? DEFAULT_SESSION_PROFILE.budget;\n    const definition = this.catalog.get(request.definition) as AnyDefinition;\n',
)
replace_once(
    "modules/phenix-pi/application/execution-facade.ts",
    '          parent.definitionId,\n          difficulty,\n        );\n',
    '          parent.definitionId,\n          difficulty,\n          budget,\n        );\n',
)
replace_once(
    "modules/phenix-pi/application/execution-facade.ts",
    '      difficulty,\n      capabilities,\n',
    '      difficulty,\n      budget,\n      capabilities,\n',
)

replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    'import type { Difficulty, ResolvedModel } from "../domain/definition/model.ts";\n',
    'import type { BudgetMode } from "../domain/definition/effort.ts";\nimport type { Difficulty, ResolvedModel } from "../domain/definition/model.ts";\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    'import type { ModelResolver } from "../ports/model-resolver.ts";\n',
    'import { passthroughBudgetPolicy, type BudgetPolicy } from "../ports/budget-policy.ts";\nimport type { ModelResolver } from "../ports/model-resolver.ts";\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '  private readonly models: ModelResolver;\n  private readonly rootInvokableDefinitions: readonly DefinitionId[];\n',
    '  private readonly models: ModelResolver;\n  private readonly budgetPolicy: BudgetPolicy;\n  private readonly rootInvokableDefinitions: readonly DefinitionId[];\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '    readonly models: ModelResolver;\n    readonly rootInvokableDefinitions: readonly DefinitionId[];\n',
    '    readonly models: ModelResolver;\n    readonly budgetPolicy?: BudgetPolicy;\n    readonly rootInvokableDefinitions: readonly DefinitionId[];\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '    this.models = input.models;\n    this.rootInvokableDefinitions = input.rootInvokableDefinitions;\n',
    '    this.models = input.models;\n    this.budgetPolicy = input.budgetPolicy ?? passthroughBudgetPolicy;\n    this.rootInvokableDefinitions = input.rootInvokableDefinitions;\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '    readonly difficulty: Difficulty;\n    readonly capabilities: CapabilitySet;\n',
    '    readonly difficulty: Difficulty;\n    readonly budget: BudgetMode;\n    readonly capabilities: CapabilitySet;\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '        difficulty: input.difficulty,\n        limits: applyRetryLimits(definition.limits, input.retryOverrides?.limits),\n',
    '        difficulty: input.difficulty,\n        budget: input.budget,\n        limits: applyRetryLimits(\n          this.budgetPolicy.applyAgentLimits(definition.limits, input.budget),\n          input.retryOverrides?.limits,\n        ),\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '    difficulty: Difficulty,\n  ): Promise<ResolvedModel> {\n',
    '    difficulty: Difficulty,\n    budget: BudgetMode,\n  ): Promise<ResolvedModel> {\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '      difficulty,\n      ...(route ? { capability: route.capability } : {}),\n',
    '      difficulty,\n      budget,\n      ...(route ? { capability: route.capability } : {}),\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '  const maxTurns = override.maxTurns === null ? undefined : (override.maxTurns ?? base.maxTurns);\n  const maxToolCalls =\n',
    '  const timeoutMs = override.timeoutMs ?? base.timeoutMs;\n  const maxTurns = override.maxTurns === null ? undefined : (override.maxTurns ?? base.maxTurns);\n  const maxToolCalls =\n',
)
replace_once(
    "modules/phenix-pi/application/run-admission-policy.ts",
    '  return {\n    timeoutMs: override.timeoutMs ?? base.timeoutMs,\n',
    '  return {\n    ...(timeoutMs !== undefined ? { timeoutMs } : {}),\n',
)

replace_once(
    "modules/phenix-pi/application/profile-aware-model-resolver.ts",
    '      difficulty: context.difficulty ?? profile.difficulty,\n',
    '      difficulty: context.difficulty ?? profile.difficulty,\n      budget: context.budget ?? profile.budget,\n',
)

replace_once(
    "modules/phenix-pi/suite/phenix-routing-policy.ts",
    'import type {\n  Difficulty,\n',
    'import type {\n  Difficulty,\n',
)
replace_once(
    "modules/phenix-pi/suite/phenix-routing-policy.ts",
    'import type {\n  CapabilityRoute,\n',
    'import { phenixBudgetPolicy } from "./phenix-budget-policy.ts";\n\nimport type {\n  CapabilityRoute,\n',
)
replace_once(
    "modules/phenix-pi/suite/phenix-routing-policy.ts",
    '  revision: "phenix-routing-v3",\n',
    '  revision: "phenix-routing-v4",\n',
)
replace_once(
    "modules/phenix-pi/suite/phenix-routing-policy.ts",
    '    return {\n      capability: context.capability ?? routed.capability,\n      thinking: routed.thinking,\n    };\n',
    '    return {\n      capability: context.capability ?? routed.capability,\n      thinking: context.budget\n        ? phenixBudgetPolicy.capThinking(routed.thinking, context.budget)\n        : routed.thinking,\n    };\n',
)

replace_once(
    "modules/phenix-pi/adapters/routing/phenix-provider.ts",
    '    difficulty: profile.difficulty,\n',
    '    difficulty: profile.difficulty,\n    budget: profile.budget,\n',
)

replace_once(
    "modules/phenix-pi/application/interfaces.ts",
    'import type { Difficulty, PhenixModelSetId } from "../domain/definition/model.ts";\n',
    'import type { BudgetMode } from "../domain/definition/effort.ts";\nimport type { Difficulty, PhenixModelSetId } from "../domain/definition/model.ts";\n',
)
replace_once(
    "modules/phenix-pi/application/interfaces.ts",
    '  readonly difficulty?: Difficulty;\n  readonly source:',
    '  readonly difficulty?: Difficulty;\n  readonly budget?: BudgetMode;\n  readonly source:',
)

replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    'import { isPhenixModelSet } from "../domain/definition/model.ts";\n',
    'import { isBudgetMode } from "../domain/definition/effort.ts";\nimport { isPhenixModelSet } from "../domain/definition/model.ts";\n',
)
replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    '  isSessionAgentPreset,\n  type SessionProfile,\n',
    '  isSessionAgentPreset,\n  normalizeSessionProfile,\n  type SessionProfile,\n',
)
replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    '    return root.profile ?? DEFAULT_SESSION_PROFILE;\n',
    '    return normalizeSessionProfile(root.profile);\n',
)
replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    '    const previous = root.profile ?? DEFAULT_SESSION_PROFILE;\n',
    '    const previous = normalizeSessionProfile(root.profile);\n',
)
replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    '    if (update.modelSet !== undefined && !isPhenixModelSet(update.modelSet)) {\n      throw new Error(`Unknown Phenix model set: ${String(update.modelSet)}`);\n    }\n\n',
    '    if (update.modelSet !== undefined && !isPhenixModelSet(update.modelSet)) {\n      throw new Error(`Unknown Phenix model set: ${String(update.modelSet)}`);\n    }\n    if (update.budget !== undefined && !isBudgetMode(update.budget)) {\n      throw new Error(`Unknown Phenix budget mode: ${String(update.budget)}`);\n    }\n\n',
)
replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    '      difficulty: update.difficulty ?? previous.difficulty,\n',
    '      difficulty: update.difficulty ?? previous.difficulty,\n      budget: update.budget ?? previous.budget,\n',
)
replace_once(
    "modules/phenix-pi/application/session-profile-facade.ts",
    '    left.modelSet === right.modelSet &&\n    left.difficulty === right.difficulty\n',
    '    left.modelSet === right.modelSet &&\n    left.difficulty === right.difficulty &&\n    left.budget === right.budget\n',
)

replace_once(
    "modules/phenix-pi/domain/run/reducer.ts",
    'import type { RunRecord, RunState, SessionProfile } from "./model.ts";\n',
    'import {\n  normalizeSessionProfile,\n  type PersistedSessionProfile,\n  type RunRecord,\n  type RunState,\n} from "./model.ts";\n',
)
replace_once(
    "modules/phenix-pi/domain/run/reducer.ts",
    '        const data = event.data as { readonly profile: SessionProfile };\n        next = { ...next, profile: data.profile };\n',
    '        const data = event.data as { readonly profile: PersistedSessionProfile };\n        next = { ...next, profile: normalizeSessionProfile(data.profile) };\n',
)

replace_once(
    "modules/phenix-pi/application/agent-executor.ts",
    '  timeoutRemainingMs: number;\n',
    '  timeoutRemainingMs?: number;\n',
)
replace_once(
    "modules/phenix-pi/application/agent-executor.ts",
    '  private armTimeout(runId: RunId, live: LiveAgent): void {\n    this.pauseTimeout(live);\n    if (live.limits.timeoutMs <= 0 || live.timeoutRemainingMs <= 0) {\n      if (live.limits.timeoutMs <= 0) return;\n    }\n    const remaining = Math.max(0, live.timeoutRemainingMs);\n',
    '  private armTimeout(runId: RunId, live: LiveAgent): void {\n    this.pauseTimeout(live);\n    const timeoutMs = live.limits.timeoutMs;\n    if (timeoutMs === undefined || timeoutMs <= 0) return;\n    const remaining = Math.max(0, live.timeoutRemainingMs ?? timeoutMs);\n    live.timeoutRemainingMs = remaining;\n',
)
replace_once(
    "modules/phenix-pi/application/agent-executor.ts",
    '          `Agent timed out after ${live.limits.timeoutMs}ms of active execution`,\n',
    '          `Agent timed out after ${timeoutMs}ms of active execution`,\n',
)
replace_once(
    "modules/phenix-pi/application/agent-executor.ts",
    '          { timeoutMs: Math.min(3_600_000, Math.max(live.limits.timeoutMs * 2, 60_000)) },\n',
    '          { timeoutMs: Math.min(3_600_000, Math.max(timeoutMs * 2, 60_000)) },\n',
)
replace_once(
    "modules/phenix-pi/application/agent-executor.ts",
    '      live.timeoutRemainingMs = Math.max(0, live.timeoutRemainingMs - elapsed);\n',
    '      if (live.timeoutRemainingMs !== undefined) {\n        live.timeoutRemainingMs = Math.max(0, live.timeoutRemainingMs - elapsed);\n      }\n',
)

replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    '  readonly timeoutRemainingMs: number;\n',
    '  readonly timeoutRemainingMs?: number;\n',
)
replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    '  readonly timeoutRemainingMs: number;\n',
    '  readonly timeoutRemainingMs?: number;\n',
)
replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    '  readonly timeoutRemainingMs: number;\n',
    '  readonly timeoutRemainingMs?: number;\n',
)
replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    '  const next: RunLimits = {\n    timeoutMs,\n',
    '  const next: RunLimits = {\n    ...(timeoutMs === undefined ? {} : { timeoutMs }),\n',
)
replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    '): number {\n  if (suspension.currentLimits.timeoutMs <= 0) return suspension.timeoutRemainingMs;\n  const added = Math.max(0, nextLimits.timeoutMs - suspension.currentLimits.timeoutMs);\n  return Math.max(0, suspension.timeoutRemainingMs + added);\n}\n',
    '): number | undefined {\n  const currentTimeout = suspension.currentLimits.timeoutMs;\n  const nextTimeout = nextLimits.timeoutMs;\n  if (currentTimeout === undefined || nextTimeout === undefined) {\n    return suspension.timeoutRemainingMs;\n  }\n  if (currentTimeout <= 0) return suspension.timeoutRemainingMs;\n  const added = Math.max(0, nextTimeout - currentTimeout);\n  return Math.max(0, (suspension.timeoutRemainingMs ?? currentTimeout) + added);\n}\n',
)
replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    'function resolveTimeoutLimit(current: number, requested: number | undefined): number {\n  if (requested === undefined) return current;\n  if (current <= 0) {\n',
    'function resolveTimeoutLimit(\n  current: number | undefined,\n  requested: number | undefined,\n): number | undefined {\n  if (requested === undefined) return current;\n  if (current === undefined || current <= 0) {\n',
)
replace_once(
    "modules/phenix-pi/application/budget-suspension.ts",
    'function timeoutIncreased(current: number, next: number): boolean {\n  return current > 0 && next > current;\n}\n',
    'function timeoutIncreased(\n  current: number | undefined,\n  next: number | undefined,\n): boolean {\n  return current !== undefined && next !== undefined && current > 0 && next > current;\n}\n',
)

replace_once(
    "modules/phenix-pi/extension/observability-theme.ts",
    '  profile: { readonly agent: string; readonly modelSet: string; readonly difficulty: string },\n',
    '  profile: { readonly agent: string; readonly modelSet: string; readonly budget: string },\n',
)
replace_once(
    "modules/phenix-pi/extension/observability-theme.ts",
    '  )}${color(theme, "dim", `/${profile.difficulty}`)}`;\n',
    '  )}${color(theme, "dim", `/${profile.budget}`)}`;\n',
)

replace_once(
    "modules/phenix-pi/application/workspace/views/runs-view.ts",
    '      const expandable = Boolean(run.resolvedModel || run.profile || run.pi?.sessionId);\n',
    '      const expandable = Boolean(\n        run.resolvedModel || run.profile || run.compiled.budget || run.pi?.sessionId,\n      );\n',
)
replace_once(
    "modules/phenix-pi/application/workspace/views/runs-view.ts",
    '            textSpan(label, { strong: true }),\n',
    '            textSpan(label, { strong: true }),\n            ...(run.kind === "agent" && run.compiled.difficulty\n              ? [textSpan(` · ${run.compiled.difficulty}`, { tone: "accent" as const })]\n              : []),\n',
)
replace_once(
    "modules/phenix-pi/application/workspace/views/runs-view.ts",
    '  if (run.resolvedModel) {\n    details.push(`${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`);\n  } else if (run.profile) {\n    details.push(`${run.profile.modelSet}/${run.profile.difficulty}`);\n  }\n',
    '  if (run.resolvedModel) {\n    details.push(`${run.resolvedModel.concrete.model}/${run.resolvedModel.thinking}`);\n  } else if (run.profile) {\n    details.push(`${run.profile.modelSet}/budget-${run.profile.budget}`);\n  }\n  if (run.kind === "agent" && run.compiled.budget) {\n    details.push(`budget ${run.compiled.budget}`);\n  }\n',
)

replace_once(
    "modules/phenix-pi/extension/phenix-ui.ts",
    '${strong(this.theme, this.snapshot.profile.agent)}/${color(this.theme, "accent", this.snapshot.profile.modelSet)}/${this.snapshot.profile.difficulty} `;',
    '${strong(this.theme, this.snapshot.profile.agent)}/${color(this.theme, "accent", this.snapshot.profile.modelSet)}/${this.snapshot.profile.budget} `;',
)

write(
    "modules/phenix-pi/extension/budget-mode-selection.ts",
    '''import {
  isBudgetMode,
  type BudgetMode,
} from "../domain/definition/effort.ts";

export const BUDGET_MODE_SELECTION_EVENT = "phenix:budget-mode-selection";

export interface BudgetModeEventBus {
  readonly on: (event: string, listener: (value: unknown) => void) => unknown;
  readonly emit: (event: string, value: unknown) => unknown;
}

export function publishBudgetModeSelection(events: BudgetModeEventBus, budget: BudgetMode): void {
  events.emit(BUDGET_MODE_SELECTION_EVENT, budget);
}

export function subscribeBudgetModeSelection(
  events: BudgetModeEventBus,
  listener: (budget: BudgetMode) => void,
): void {
  events.on(BUDGET_MODE_SELECTION_EVENT, (value) => {
    if (typeof value === "string" && isBudgetMode(value)) listener(value);
  });
}
''',
)

replace_once(
    "modules/phenix-pi/extension/workspace/workspace-standard-builtins.ts",
    'import type { WorkspaceSelectDialogItem } from "./workspace-select-dialog.ts";\n',
    'import { BUDGET_MODES, type BudgetMode } from "../../domain/definition/effort.ts";\nimport { publishBudgetModeSelection } from "../budget-mode-selection.ts";\nimport type { WorkspaceSelectDialogItem } from "./workspace-select-dialog.ts";\n',
)
replace_once(
    "modules/phenix-pi/extension/workspace/workspace-standard-builtins.ts",
    '          label: "Thinking level",\n',
    '          label: ctx.model?.provider === "phenix" ? "Budget mode" : "Thinking level",\n',
)
replace_once(
    "modules/phenix-pi/extension/workspace/workspace-standard-builtins.ts",
    '  const current = pi.getThinkingLevel();\n  const level = await pickWorkspaceItem(ctx, {\n    title: "Thinking level",\n    items: THINKING_LEVELS.map((value) => ({\n',
    '  const current = pi.getThinkingLevel();\n  const usesPhenixBudget = ctx.model?.provider === "phenix";\n  const levels = usesPhenixBudget ? BUDGET_MODES : THINKING_LEVELS;\n  const level = await pickWorkspaceItem(ctx, {\n    title: usesPhenixBudget ? "Budget mode" : "Thinking level",\n    items: levels.map((value) => ({\n',
)
replace_once(
    "modules/phenix-pi/extension/workspace/workspace-standard-builtins.ts",
    '  settings.setDefaultThinkingLevel(level);\n  await settings.flush();\n',
    '  settings.setDefaultThinkingLevel(level);\n  await settings.flush();\n  if (usesPhenixBudget) publishBudgetModeSelection(pi.events, level as BudgetMode);\n',
)

replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    'import { isPhenixModelSet, PHENIX_MODEL_SETS } from "../domain/definition/model.ts";\n',
    'import { BUDGET_MODES, isBudgetMode } from "../domain/definition/effort.ts";\nimport { isPhenixModelSet, PHENIX_MODEL_SETS } from "../domain/definition/model.ts";\n',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    'import { copyFactHistory, parseFactsCommand, writeFactHistory } from "./fact-export.ts";\n',
    'import { subscribeBudgetModeSelection } from "./budget-mode-selection.ts";\nimport { copyFactHistory, parseFactsCommand, writeFactHistory } from "./fact-export.ts";\n',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    '  });\n  integrationStatuses = await loadPiIntegrations(pi);\n',
    '  });\n  subscribeBudgetModeSelection(pi.events, (budget) => {\n    void (async () => {\n      if (!runtime || !rootRunId) return;\n      await runtime.profiles.select(rootRunId, { budget, source: "user" });\n    })();\n  });\n  integrationStatuses = await loadPiIntegrations(pi);\n',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    '    if (ctx.model?.provider === "phenix" && isPhenixModelSet(ctx.model.id)) {\n      await currentRuntime.profiles.select(currentRoot, {\n        modelSet: ctx.model.id,\n        source: "model-select",\n      });\n    }\n\n',
    '    if (ctx.model?.provider === "phenix" && isPhenixModelSet(ctx.model.id)) {\n      await currentRuntime.profiles.select(currentRoot, {\n        modelSet: ctx.model.id,\n        source: "model-select",\n      });\n      pi.setThinkingLevel((await currentRuntime.profiles.current(currentRoot)).budget);\n    }\n\n',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    '  pi.on("before_agent_start", async (event) => {\n    if (!runtime || !rootRunId) return;\n    const [available, active, profile] = await Promise.all([\n',
    '  pi.on("before_agent_start", async (event) => {\n    if (!runtime || !rootRunId) return;\n    await syncBudgetFromThinking(pi, runtime, rootRunId);\n    const [available, active, profile] = await Promise.all([\n',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    'Session profile: agent=${profile.agent}, modelSet=${profile.modelSet}, difficulty=${profile.difficulty}.',
    'Session profile: agent=${profile.agent}, modelSet=${profile.modelSet}, budget=${profile.budget}. Default difficulty=${profile.difficulty}; every child run records its own effective difficulty.',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    '      await runtime.profiles.select(rootRunId, {\n        modelSet: event.model.id,\n        source: "model-select",\n      });\n      return;\n',
    '      await runtime.profiles.select(rootRunId, {\n        modelSet: event.model.id,\n        source: "model-select",\n      });\n      pi.setThinkingLevel((await runtime.profiles.current(rootRunId)).budget);\n      return;\n',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    '  pi.registerCommand("difficulty", {\n',
    '  pi.registerCommand("budget", {\n    description: `Select the session execution budget; usage: /budget ${BUDGET_MODES.join("|")}`,\n    handler: async (args, ctx) => {\n      const active = requireRuntime(runtime, rootRunId);\n      const selected = args.trim().toLowerCase();\n      if (!isBudgetMode(selected)) {\n        const profile = await active.runtime.profiles.current(active.root);\n        ctx.ui.notify(\n          `Budget: ${profile.budget}\\nAvailable: ${BUDGET_MODES.join(", ")}`,\n          selected ? "warning" : "info",\n        );\n        return;\n      }\n      await active.runtime.profiles.select(active.root, { budget: selected, source: "user" });\n      pi.setThinkingLevel(selected);\n      await updateStatus(ctx, active.runtime, active.root);\n    },\n  });\n\n  pi.registerCommand("difficulty", {\n',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    '      pi.setThinkingLevel(thinkingForDifficulty(selected));\n      await updateStatus(ctx, active.runtime, active.root);\n',
    '      await updateStatus(ctx, active.runtime, active.root);\n',
)
replace_once(
    "modules/phenix-pi/extension/root-extension.ts",
    'function thinkingForDifficulty(difficulty: SessionProfile["difficulty"]) {\n  return difficulty === "D0"\n    ? "minimal"\n    : difficulty === "D1"\n      ? "low"\n      : difficulty === "D2"\n        ? "high"\n        : "xhigh";\n}\n\n',
    'async function syncBudgetFromThinking(\n  pi: ExtensionAPI,\n  runtime: PhenixRuntime,\n  rootRunId: RunId,\n): Promise<void> {\n  const selected = pi.getThinkingLevel();\n  if (!isBudgetMode(selected)) return;\n  const profile = await runtime.profiles.current(rootRunId);\n  if (profile.budget === selected) return;\n  await runtime.profiles.select(rootRunId, { budget: selected, source: "user" });\n}\n\n',
)

replace_once(
    "modules/phenix-pi/tests/session-profile.test.ts",
    '    difficulty: "D1",\n  });\n',
    '    difficulty: "D1",\n    budget: "medium",\n  });\n',
)
replace_once(
    "modules/phenix-pi/tests/session-profile.test.ts",
    '    difficulty: "D3",\n    source: "user",\n',
    '    difficulty: "D3",\n    budget: "high",\n    source: "user",\n',
)
replace_once(
    "modules/phenix-pi/tests/session-profile.test.ts",
    '    difficulty: "D3",\n  });\n',
    '    difficulty: "D3",\n    budget: "high",\n  });\n',
)

replace_once(
    "modules/phenix-pi/tests/observability-theme.test.ts",
    'profile: { agent: "base", modelSet: "mixed", difficulty: "D1" },',
    'profile: { agent: "base", modelSet: "mixed", difficulty: "D1", budget: "medium" },',
)
replace_once(
    "modules/phenix-pi/tests/observability-theme.test.ts",
    'const active = statusLine(THEME, { agent: "base", modelSet: "mixed", difficulty: "D2" }, 3);\n  const idle = statusLine(THEME, { agent: "base", modelSet: "mixed", difficulty: "D2" }, 0);',
    'const active = statusLine(THEME, { agent: "base", modelSet: "mixed", budget: "high" }, 3);\n  const idle = statusLine(THEME, { agent: "base", modelSet: "mixed", budget: "high" }, 0);',
)
replace_once(
    "modules/phenix-pi/tests/observability-theme.test.ts",
    '  assert.match(active, /<accent>mixed<\\/accent>/);\n  assert.doesNotMatch(active, /active|idle/);\n',
    '  assert.match(active, /<accent>mixed<\\/accent>/);\n  assert.match(active, /high/);\n  assert.doesNotMatch(active, /D2|active|idle/);\n',
)

replace_once(
    "modules/phenix-pi/tests/workspace-view-registry.test.ts",
    '      profile: { agent: "base", modelSet: "free", difficulty: "D1" },\n',
    '      profile: { agent: "base", modelSet: "free", difficulty: "D1", budget: "high" },\n',
)
replace_once(
    "modules/phenix-pi/tests/workspace-view-registry.test.ts",
    '  assert.doesNotMatch(collapsed, /free\\/D1|session-123/);\n',
    '  assert.doesNotMatch(collapsed, /free|budget-high|session-123|D1/);\n',
)
replace_once(
    "modules/phenix-pi/tests/workspace-view-registry.test.ts",
    '  assert.match(expanded, /free\\/D1/);\n',
    '  assert.match(expanded, /free\\/budget-high/);\n',
)
replace_once(
    "modules/phenix-pi/tests/workspace-view-registry.test.ts",
    'test("run rows surface normal and urgent input requirements", () => {\n',
    'test("agent session rows show their own compiled difficulty while collapsed", () => {\n  const childBase = runNode("child", "running");\n  const child = {\n    ...childBase,\n    run: {\n      ...childBase.run,\n      compiled: { ...childBase.run.compiled, difficulty: "D2", budget: "high" },\n    } as RunSnapshot,\n  } satisfies RunTreeNode;\n  const root = runNode("root", "running", [child], "root");\n  const snapshot = {\n    ui: { tree: { root }, facts: [] },\n    tasks: { root: taskNode("root-task", "wip") },\n  } as unknown as PhenixWorkspaceSnapshot;\n  const row = runsWorkspaceView.project(snapshot).find((candidate) => candidate.id === "child");\n  assert.ok(row);\n\n  const collapsed = row.render({\n    theme: THEME,\n    width: 120,\n    activeRunId: root.run.id,\n    expanded: false,\n  }).text;\n  assert.match(collapsed, /D2/);\n  assert.doesNotMatch(collapsed, /budget high/);\n});\n\ntest("run rows surface normal and urgent input requirements", () => {\n',
)

replace_once(
    "modules/phenix-pi/tests/model-routing.test.ts",
    '  difficulty: "D0" | "D1" | "D2" | "D3",\n) {\n',
    '  difficulty: "D0" | "D1" | "D2" | "D3",\n  budget?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",\n) {\n',
)
replace_once(
    "modules/phenix-pi/tests/model-routing.test.ts",
    '      difficulty,\n    },\n',
    '      difficulty,\n      ...(budget ? { budget } : {}),\n    },\n',
)
replace_once(
    "modules/phenix-pi/tests/model-routing.test.ts",
    'test("OpenCode Go, ChatGPT Plus, and mixed select the capability-specific provider", async () => {\n',
    'test("session budget caps routed reasoning without changing capability selection", async () => {\n  const low = await resolve("free", "agent.implementer", "D3", "low");\n  const high = await resolve("free", "agent.implementer", "D3", "high");\n  assert.equal(low.capability, "code-max");\n  assert.equal(high.capability, "code-max");\n  assert.equal(low.thinking, "low");\n  assert.equal(high.thinking, "high");\n});\n\ntest("OpenCode Go, ChatGPT Plus, and mixed select the capability-specific provider", async () => {\n',
)

write(
    "modules/phenix-pi/tests/budget-policy.test.ts",
    '''import assert from "node:assert/strict";
import test from "node:test";

import { phenixBudgetPolicy } from "../suite/phenix-budget-policy.ts";

const BASE = {
  timeoutMs: 900_000,
  maxTurns: 18,
  maxRepairAttempts: 2,
} as const;

test("budget tiers scale agent resources around the definition baseline", () => {
  assert.deepEqual(phenixBudgetPolicy.applyAgentLimits(BASE, "medium"), BASE);
  assert.deepEqual(phenixBudgetPolicy.applyAgentLimits(BASE, "low"), {
    timeoutMs: 675_000,
    maxTurns: 14,
    maxToolCalls: 84,
    maxRepairAttempts: 1,
  });
  assert.deepEqual(phenixBudgetPolicy.applyAgentLimits(BASE, "high"), {
    timeoutMs: 1_800_000,
    maxTurns: 36,
    maxRepairAttempts: 3,
  });
});

test("max removes agent resource ceilings but keeps repair loops bounded", () => {
  assert.deepEqual(phenixBudgetPolicy.applyAgentLimits(BASE, "max"), {
    maxRepairAttempts: 5,
  });
});

test("budget caps reasoning independently from routed capability", () => {
  assert.equal(phenixBudgetPolicy.capThinking("xhigh", "low"), "low");
  assert.equal(phenixBudgetPolicy.capThinking("xhigh", "medium"), "xhigh");
  assert.equal(phenixBudgetPolicy.capThinking("max", "high"), "xhigh");
  assert.equal(phenixBudgetPolicy.capThinking("high", "max"), "high");
});
''',
)

print("session budget mode patch applied")
