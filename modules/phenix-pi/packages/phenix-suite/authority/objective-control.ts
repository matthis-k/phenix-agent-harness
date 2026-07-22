import type { ExecutionAuthority } from "./service.ts";
import type {
  AuthorityMutation,
  BeginObjectiveInput,
  ExecutionAuthoritySnapshot,
  ObjectiveRecord,
} from "./types.ts";

export interface ObjectiveControlPort {
  begin(input: BeginObjectiveInput, mutation: AuthorityMutation): ObjectiveRecord;
  inspect(objectiveId: string): ExecutionAuthoritySnapshot;
  pause(objectiveId: string, mutation: AuthorityMutation): ObjectiveRecord;
  resume(objectiveId: string, mutation: AuthorityMutation): ObjectiveRecord;
  amend(objectiveId: string, amendment: string, mutation: AuthorityMutation): ObjectiveRecord;
  discard(objectiveId: string, reason: string, mutation: AuthorityMutation): ObjectiveRecord;
}

export function objectiveControl(authority: ExecutionAuthority): ObjectiveControlPort {
  return {
    begin: (input, mutation) => authority.beginObjective(input, mutation),
    inspect: (objectiveId) => authority.inspectObjective(objectiveId),
    pause: (objectiveId, mutation) => authority.pauseObjective(objectiveId, mutation),
    resume: (objectiveId, mutation) => authority.resumeObjective(objectiveId, mutation),
    amend: (objectiveId, amendment, mutation) =>
      authority.amendObjective(objectiveId, amendment, mutation),
    discard: (objectiveId, reason, mutation) =>
      authority.discardObjective(objectiveId, reason, mutation),
  };
}
