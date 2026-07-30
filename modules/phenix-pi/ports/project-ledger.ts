import type {
  ProjectEvent,
  ProjectId,
  UnsequencedProjectEvent,
} from "../domain/project/model.ts";

export class ProjectLedgerConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Project ledger revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
  }
}

export interface ProjectLedger {
  list(): Promise<readonly ProjectId[]>;
  load(projectId: ProjectId): Promise<readonly ProjectEvent[]>;
  append(
    projectId: ProjectId,
    expectedRevision: number,
    events: readonly UnsequencedProjectEvent[],
  ): Promise<readonly ProjectEvent[]>;
}
