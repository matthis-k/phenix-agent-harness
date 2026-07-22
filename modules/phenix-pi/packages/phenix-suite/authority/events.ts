import type { ExecutionAuthority } from "./service.ts";
import type { ExecutionAuthorityEvent } from "./types.ts";

export interface ExecutionEventCursor {
  readonly sequence: number;
  readonly objectiveId?: string;
}

export interface ExecutionEventBatch {
  readonly events: readonly ExecutionAuthorityEvent[];
  readonly nextCursor: ExecutionEventCursor;
}

export function readExecutionEvents(
  authority: ExecutionAuthority,
  cursor: ExecutionEventCursor,
): ExecutionEventBatch {
  const events = authority.eventsAfter(cursor.sequence, cursor.objectiveId);
  return {
    events,
    nextCursor: {
      sequence: events.at(-1)?.sequence ?? cursor.sequence,
      ...(cursor.objectiveId ? { objectiveId: cursor.objectiveId } : {}),
    },
  };
}
