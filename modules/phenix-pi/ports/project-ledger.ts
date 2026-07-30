import type {
  ProjectEvent,
  ProjectId,
  UnsequencedProjectEvent,
} from "../domain/project/model.ts";

export class ProjectLedgerConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(`Project ledger revision conflict: expected ${expectedRevision}, found ${actualRevision}`);
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
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
