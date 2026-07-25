import type { WorkflowDefinition } from "../definition/definition.ts";
import type { DomainEvent } from "../run/events.ts";
import type { DefinitionId } from "../shared.ts";

export interface WorkflowCheckpointActivation {
  readonly activationId: string;
  readonly nodeId: string;
  readonly enteredSequence: number;
  readonly completed: boolean;
  readonly result?: unknown;
}

export interface WorkflowCheckpointSnapshot {
  readonly activations: readonly WorkflowCheckpointActivation[];
  readonly results: readonly (readonly [string, readonly unknown[]])[];
  readonly transitionCounts: readonly (readonly [string, number])[];
}

export interface WorkflowCheckpointSavedData {
  readonly version: 1;
  readonly definitionId: DefinitionId;
  readonly definitionFingerprint: string;
  readonly throughSequence: number;
  readonly snapshotFingerprint: string;
  readonly snapshot: WorkflowCheckpointSnapshot;
}

export interface RestoredWorkflowCheckpoint {
  readonly throughSequence: number;
  readonly snapshot: WorkflowCheckpointSnapshot;
}

export function createWorkflowCheckpoint(input: {
  readonly definition: WorkflowDefinition<unknown, unknown>;
  readonly throughSequence: number;
  readonly snapshot: WorkflowCheckpointSnapshot;
}): WorkflowCheckpointSavedData {
  return {
    version: 1,
    definitionId: input.definition.id,
    definitionFingerprint: workflowDefinitionFingerprint(input.definition),
    throughSequence: input.throughSequence,
    snapshotFingerprint: stableFingerprint(input.snapshot),
    snapshot: input.snapshot,
  };
}

export function latestCompatibleWorkflowCheckpoint(input: {
  readonly definition: WorkflowDefinition<unknown, unknown>;
  readonly events: readonly DomainEvent[];
}): RestoredWorkflowCheckpoint | undefined {
  const definitionFingerprint = workflowDefinitionFingerprint(input.definition);
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index];
    if (event?.type !== "workflow.checkpoint.saved") continue;
    const data = validCheckpointData(event.data);
    if (!data) continue;
    if (data.definitionId !== input.definition.id) continue;
    if (data.definitionFingerprint !== definitionFingerprint) continue;
    if (data.throughSequence < 1 || data.throughSequence >= event.sequence) continue;
    if (data.snapshotFingerprint !== stableFingerprint(data.snapshot)) continue;
    if (!validSnapshot(data.snapshot, input.definition, data.throughSequence)) continue;
    return { throughSequence: data.throughSequence, snapshot: data.snapshot };
  }
  return undefined;
}

export function workflowDefinitionFingerprint(
  definition: WorkflowDefinition<unknown, unknown>,
): string {
  return stableFingerprint({
    id: definition.id,
    input: definition.input.id,
    output: definition.output.id,
    graph: definition.graph,
    limits: definition.limits,
  });
}

export function workflowSnapshotFingerprint(snapshot: WorkflowCheckpointSnapshot): string {
  return stableFingerprint(snapshot);
}

function validCheckpointData(value: unknown): WorkflowCheckpointSavedData | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.definitionId !== "string") return undefined;
  if (typeof value.definitionFingerprint !== "string") return undefined;
  if (typeof value.throughSequence !== "number" || !Number.isInteger(value.throughSequence)) {
    return undefined;
  }
  if (typeof value.snapshotFingerprint !== "string") return undefined;
  if (!isRecord(value.snapshot)) return undefined;
  return value as unknown as WorkflowCheckpointSavedData;
}

function validSnapshot(
  snapshot: WorkflowCheckpointSnapshot,
  definition: WorkflowDefinition<unknown, unknown>,
  throughSequence: number,
): boolean {
  if (
    !Array.isArray(snapshot.activations) ||
    !Array.isArray(snapshot.results) ||
    !Array.isArray(snapshot.transitionCounts)
  ) {
    return false;
  }

  const nodeIds = new Set(definition.graph.nodes.map((node) => node.id));
  const activationIds = new Set<string>();
  for (const activation of snapshot.activations) {
    if (!isRecord(activation)) return false;
    if (typeof activation.activationId !== "string" || activationIds.has(activation.activationId)) {
      return false;
    }
    if (typeof activation.nodeId !== "string" || !nodeIds.has(activation.nodeId)) return false;
    const enteredSequence = activation.enteredSequence;
    if (
      typeof enteredSequence !== "number" ||
      !Number.isInteger(enteredSequence) ||
      enteredSequence < 1 ||
      enteredSequence > throughSequence
    ) {
      return false;
    }
    if (typeof activation.completed !== "boolean") return false;
    activationIds.add(activation.activationId);
  }

  const resultNodes = new Set<string>();
  for (const entry of snapshot.results) {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [nodeId, values] = entry;
    if (typeof nodeId !== "string" || !nodeIds.has(nodeId) || resultNodes.has(nodeId)) {
      return false;
    }
    if (!Array.isArray(values)) return false;
    resultNodes.add(nodeId);
  }

  const transitionKeys = new Set<string>();
  const validEdges = new Set(definition.graph.edges.map((edge) => `${edge.from}->${edge.to}`));
  for (const entry of snapshot.transitionCounts) {
    if (!Array.isArray(entry) || entry.length !== 2) return false;
    const [key, count] = entry;
    if (
      typeof key !== "string" ||
      !validEdges.has(key) ||
      transitionKeys.has(key) ||
      !Number.isInteger(count) ||
      count < 1
    ) {
      return false;
    }
    transitionKeys.add(key);
  }
  return true;
}

function stableFingerprint(value: unknown): string {
  const text = JSON.stringify(canonicalValue(value));
  const seeds = [
    0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5,
  ];
  return seeds.map((seed) => fnv1a(text, seed).toString(16).padStart(8, "0")).join("");
}

function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined && typeof nested !== "function")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalValue(nested)]),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
