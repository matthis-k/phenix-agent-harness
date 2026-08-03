import type { ObjectiveId, ObjectiveState, RunId } from "../shared.ts";

export type ObjectiveSource = "user" | "discovered";

export interface Objective {
  readonly id: ObjectiveId;
  readonly rootRunId: RunId;
  readonly parentObjectiveId?: ObjectiveId;
  readonly createdByRunId: RunId;
  readonly title: string;
  readonly description?: string;
  readonly source: ObjectiveSource;
  readonly state: ObjectiveState;
  readonly createdAt: string;
  readonly updatedAt: string;
}
