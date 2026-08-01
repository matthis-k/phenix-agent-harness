import { isBudgetMode } from "../domain/definition/effort.ts";
import { isPhenixModelSet } from "../domain/definition/model.ts";
import {
  isSessionAgentPreset,
  normalizeSessionProfile,
  type SessionProfile,
} from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { SessionProfileFacade, SessionProfileUpdate } from "./interfaces.ts";

export class SessionProfileFacadeImpl implements SessionProfileFacade {
  private readonly store: ExecutionStore;

  constructor(store: ExecutionStore) {
    this.store = store;
  }

  async current(rootRunId: RunId): Promise<SessionProfile> {
    const root = this.store.projection.requireRun(rootRunId);
    if (root.kind !== "root") throw new Error(`${rootRunId} is not a root session`);
    return normalizeSessionProfile(root.profile);
  }

  async select(rootRunId: RunId, update: SessionProfileUpdate): Promise<SessionProfile> {
    const root = this.store.projection.requireRun(rootRunId);
    if (root.kind !== "root") throw new Error(`${rootRunId} is not a root session`);
    const previous = normalizeSessionProfile(root.profile);

    if (update.agent !== undefined && !isSessionAgentPreset(update.agent)) {
      throw new Error(`Unknown Phenix agent preset: ${String(update.agent)}`);
    }
    if (update.modelSet !== undefined && !isPhenixModelSet(update.modelSet)) {
      throw new Error(`Unknown Phenix model set: ${String(update.modelSet)}`);
    }
    if (update.budget !== undefined && !isBudgetMode(update.budget)) {
      throw new Error(`Unknown Phenix budget mode: ${String(update.budget)}`);
    }

    const profile: SessionProfile = {
      agent: update.agent ?? previous.agent,
      modelSet: update.modelSet ?? previous.modelSet,
      difficulty: update.difficulty ?? previous.difficulty,
      budget: update.budget ?? previous.budget,
    };
    if (sameProfile(previous, profile)) return previous;

    await this.store.commit(rootRunId, [
      {
        runId: rootRunId,
        type: "run.profile.selected",
        data: { previous, profile, source: update.source },
      },
    ]);
    return this.store.projection.requireRun(rootRunId).profile ?? profile;
  }
}

function sameProfile(left: SessionProfile, right: SessionProfile): boolean {
  return (
    left.agent === right.agent &&
    left.modelSet === right.modelSet &&
    left.difficulty === right.difficulty &&
    left.budget === right.budget
  );
}
