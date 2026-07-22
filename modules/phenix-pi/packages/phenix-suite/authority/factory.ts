import { ExecutionAuthority, type ExecutionAuthorityOptions } from "./service.ts";
import type { AuthorityMutation, ObjectiveRecord } from "./types.ts";

class RevisionStrictExecutionAuthority extends ExecutionAuthority {
  override resumeObjective(objectiveId: string, mutation: AuthorityMutation): ObjectiveRecord {
    const current = this.inspectObjective(objectiveId).objective;
    if (
      mutation.expectedRevision !== undefined &&
      mutation.expectedRevision !== current.revision
    ) {
      throw new Error(
        `Stale objective revision for ${objectiveId}: expected ${mutation.expectedRevision}, current ${current.revision}.`,
      );
    }
    return super.resumeObjective(objectiveId, mutation);
  }
}

/** Public factory applies lifecycle invariants around the storage-oriented core. */
export function createExecutionAuthority(
  options: ExecutionAuthorityOptions,
): ExecutionAuthority {
  return new RevisionStrictExecutionAuthority(options);
}
