import type { WorkflowDefinition, WorkflowNode } from "../definition/definition.ts";
import type { DomainEvent } from "../run/events.ts";
import type { RunRecord } from "../run/model.ts";
import type { Outcome, RunId } from "../shared.ts";

export interface WorkflowActivation {
  readonly activationId: string;
  readonly nodeId: string;
  readonly enteredSequence: number;
  readonly completed: boolean;
  readonly result?: unknown;
}

export interface WorkflowEvaluationContext {
  readonly runId: RunId;
  readonly input: unknown;
  readonly results: ReadonlyMap<string, readonly unknown[]>;
  readonly latest: ReadonlyMap<string, unknown>;
  readonly childOutcomes: ReadonlyMap<string, readonly Outcome<unknown>[]>;
  readonly transitionCounts: ReadonlyMap<string, number>;
}

export interface WorkflowGraphState {
  readonly definition: WorkflowDefinition<unknown, unknown>;
  readonly active: readonly WorkflowActivation[];
  readonly activations: ReadonlyMap<string, WorkflowActivation>;
  readonly context: WorkflowEvaluationContext;
  readonly nodeRuns: number;
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}

export function buildWorkflowGraphState(input: {
  readonly run: RunRecord;
  readonly definition: WorkflowDefinition<unknown, unknown>;
  readonly events: readonly DomainEvent[];
  readonly children: readonly RunRecord[];
}): WorkflowGraphState {
  const activations = new Map<string, WorkflowActivation>();
  const results = new Map<string, unknown[]>();
  const transitions = new Map<string, number>();

  for (const event of input.events) {
    if (event.type === "workflow.node.entered") {
      const data = event.data as { readonly activationId: string; readonly nodeId: string };
      activations.set(data.activationId, {
        activationId: data.activationId,
        nodeId: data.nodeId,
        enteredSequence: event.sequence,
        completed: false,
      });
    }
    if (event.type === "workflow.node.completed") {
      const data = event.data as {
        readonly activationId: string;
        readonly nodeId: string;
        readonly result: unknown;
      };
      const activation = activations.get(data.activationId);
      if (activation) {
        activations.set(data.activationId, { ...activation, completed: true, result: data.result });
      }
      pushMap(results, data.nodeId, data.result);
    }
    if (event.type === "workflow.transition.taken") {
      const data = event.data as { readonly from: string; readonly to: string };
      const key = `${data.from}->${data.to}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
    }
  }

  const childOutcomes = new Map<string, Outcome<unknown>[]>();
  for (const child of input.children) {
    const causation = child.compiled.invocation.causation;
    if (!causation || child.outcome === undefined) continue;
    pushMap(childOutcomes, causation.nodeId, child.outcome);
  }

  const latest = new Map<string, unknown>();
  for (const [nodeId, values] of results) {
    if (values.length > 0) latest.set(nodeId, values[values.length - 1]);
  }

  return {
    definition: input.definition,
    active: [...activations.values()]
      .filter((activation) => !activation.completed)
      .sort((left, right) => left.enteredSequence - right.enteredSequence),
    activations,
    context: {
      runId: input.run.id,
      input: input.run.input,
      results,
      latest,
      childOutcomes,
      transitionCounts: transitions,
    },
    nodeRuns: activations.size,
  };
}

export function workflowNode(
  definition: WorkflowDefinition<unknown, unknown>,
  nodeId: string,
): WorkflowNode {
  const node = definition.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Unknown workflow node ${definition.id}/${nodeId}`);
  return node;
}
