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

function mutationFromArguments(args: readonly unknown[]): AuthorityMutation | undefined {
  const candidate = args.at(-1);
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const record = candidate as Record<string, unknown>;
  return typeof record.idempotencyKey === "string"
    ? (candidate as AuthorityMutation)
    : undefined;
}

function assertGlobalIdempotencyOwnership(
  options: ExecutionAuthorityOptions,
  operation: string,
  mutation: AuthorityMutation,
): void {
  for (const storedKey of Object.keys(options.store.load().idempotency)) {
    const separator = storedKey.indexOf(":");
    if (separator < 0) continue;
    const storedOperation = storedKey.slice(0, separator);
    const storedMutationKey = storedKey.slice(separator + 1);
    if (storedMutationKey !== mutation.idempotencyKey || storedOperation === operation) continue;
    throw new Error(
      `Idempotency key ${mutation.idempotencyKey} was reused by ${operation} after ${storedOperation}.`,
    );
  }
}

/** Public factory applies lifecycle invariants around the storage-oriented core. */
export function createExecutionAuthority(
  options: ExecutionAuthorityOptions,
): ExecutionAuthority {
  const authority = new RevisionStrictExecutionAuthority(options);
  return new Proxy(authority, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        const mutation = mutationFromArguments(args);
        if (mutation) assertGlobalIdempotencyOwnership(options, property, mutation);
        return Reflect.apply(value, target, args);
      };
    },
  });
}
