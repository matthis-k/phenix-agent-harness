import type { LocalTaskId, RunId } from "../shared.ts";

export interface LocalTask {
  readonly kind: "local";
  readonly id: LocalTaskId;
  readonly ownerRunId: RunId;
  readonly title: string;
  readonly description?: string;
  readonly state: "not_started" | "wip" | "done" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
}
