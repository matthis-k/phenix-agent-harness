import type { DiagnosticFailureCounts } from "../domain/diagnostics.ts";
import { isTerminalRunState } from "../domain/run/invariants.ts";
import type { RunRecord } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { RunTreeNode } from "./interfaces.ts";

type FailureState = keyof DiagnosticFailureCounts;

/**
 * Projects immutable run history into current failure health.
 *
 * Failed attempts are grouped through retryOf, nested failures are represented by
 * their outermost failed boundary, and successful or active non-root ancestors
 * determine whether the incident was recovered or is still being recovered.
 */
export function summarizeRunFailures(root: RunTreeNode): DiagnosticFailureCounts {
  const runs = flatten(root);
  const byId = new Map(runs.map((run) => [run.id, run]));
  const retries = retryIndex(runs);
  const candidates = runs.filter(
    (run) => isFailure(run) && retryIncidentRoot(run, byId).id === run.id,
  );
  const statusById = new Map(
    candidates.map((run) => [run.id, classifyFailure(run, byId, retries)] as const),
  );
  const visible = candidates.filter((run) => !hasClassifiedFailureAncestor(run, byId, statusById));
  const counts: Record<FailureState, number> = {
    recovering: 0,
    recovered: 0,
    terminal: 0,
  };
  for (const run of visible) counts[statusById.get(run.id) ?? "terminal"] += 1;
  return counts;
}

function classifyFailure(
  run: RunRecord,
  byId: ReadonlyMap<RunId, RunRecord>,
  retries: ReadonlyMap<RunId, readonly RunRecord[]>,
): FailureState {
  const attempts = retryAttempts(run.id, retries);
  if (attempts.some(isSuccess)) return "recovered";
  if (attempts.some(isActive)) return "recovering";

  const owners = ancestors(run, byId).filter((ancestor) => ancestor.kind !== "root");
  if (owners.some(isSuccess)) return "recovered";
  if (owners.some(isActive)) return "recovering";
  return "terminal";
}

function hasClassifiedFailureAncestor(
  run: RunRecord,
  byId: ReadonlyMap<RunId, RunRecord>,
  statusById: ReadonlyMap<RunId, FailureState>,
): boolean {
  return ancestors(run, byId).some((ancestor) => {
    if (!isFailure(ancestor)) return false;
    return statusById.has(retryIncidentRoot(ancestor, byId).id);
  });
}

function retryIndex(runs: readonly RunRecord[]): ReadonlyMap<RunId, readonly RunRecord[]> {
  const mutable = new Map<RunId, RunRecord[]>();
  for (const run of runs) {
    const retryOf = run.compiled.invocation.retryOf;
    if (!retryOf) continue;
    const attempts = mutable.get(retryOf) ?? [];
    attempts.push(run);
    mutable.set(retryOf, attempts);
  }
  return mutable;
}

function retryAttempts(
  runId: RunId,
  retries: ReadonlyMap<RunId, readonly RunRecord[]>,
): readonly RunRecord[] {
  const attempts: RunRecord[] = [];
  const pending = [...(retries.get(runId) ?? [])];
  const seen = new Set<RunId>();
  while (pending.length > 0) {
    const attempt = pending.shift();
    if (!attempt || seen.has(attempt.id)) continue;
    seen.add(attempt.id);
    attempts.push(attempt);
    pending.push(...(retries.get(attempt.id) ?? []));
  }
  return attempts;
}

function retryIncidentRoot(run: RunRecord, byId: ReadonlyMap<RunId, RunRecord>): RunRecord {
  let current = run;
  const seen = new Set<RunId>();
  while (current.compiled.invocation.retryOf) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    const previous = byId.get(current.compiled.invocation.retryOf);
    if (!previous) break;
    current = previous;
  }
  return current;
}

function ancestors(run: RunRecord, byId: ReadonlyMap<RunId, RunRecord>): readonly RunRecord[] {
  const output: RunRecord[] = [];
  const seen = new Set<RunId>();
  let parentId = run.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    output.push(parent);
    parentId = parent.parentId;
  }
  return output;
}

function flatten(node: RunTreeNode): readonly RunRecord[] {
  return [node.run, ...node.children.flatMap(flatten)];
}

function isFailure(run: RunRecord): boolean {
  return run.outcome?.status === "failure";
}

function isSuccess(run: RunRecord): boolean {
  return run.outcome?.status === "success";
}

function isActive(run: RunRecord): boolean {
  return !isTerminalRunState(run.state);
}
