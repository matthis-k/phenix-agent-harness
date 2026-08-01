import type {
  DecisionNode,
  FailNode,
  InvokeNode,
  JoinNode,
  LocalNode,
  ReturnNode,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTransitionOutcome,
} from "../definition/definition.ts";
import { isTerminalRunState } from "../run/invariants.ts";
import type { RunRecord } from "../run/model.ts";
import type { Failure, Outcome } from "../shared.ts";
import type { WorkflowActivation, WorkflowGraphState } from "./graph-state.ts";

export type WorkflowBlockedReason =
  | "child-running"
  | "parallelism-limit"
  | "join-incomplete"
  | "attached-children";

interface ActivationPlan<N extends WorkflowNode> {
  readonly activationId: string;
  readonly node: N;
}

export type WorkflowStepPlan =
  | { readonly kind: "fail-workflow"; readonly failure: Failure }
  | {
      readonly kind: "wait";
      readonly blocked: readonly {
        readonly activationId: string;
        readonly nodeId: string;
        readonly reason: WorkflowBlockedReason;
      }[];
    }
  | ({ readonly kind: "run-local" } & ActivationPlan<LocalNode>)
  | ({ readonly kind: "evaluate-decision" } & ActivationPlan<DecisionNode>)
  | ({ readonly kind: "start-child" } & ActivationPlan<InvokeNode>)
  | ({ readonly kind: "retry-child"; readonly child: RunRecord } & ActivationPlan<InvokeNode>)
  | ({ readonly kind: "complete-invoke"; readonly child: RunRecord } & ActivationPlan<InvokeNode>)
  | ({ readonly kind: "complete-join"; readonly result: unknown } & ActivationPlan<JoinNode>)
  | ({ readonly kind: "complete-return" } & ActivationPlan<ReturnNode>)
  | ({ readonly kind: "fail-node" } & ActivationPlan<FailNode>);

export interface WorkflowPlannerInput {
  readonly state: WorkflowGraphState;
  readonly children: readonly RunRecord[];
  readonly activeAttachedChildren: number;
  readonly selectEdges: (
    state: WorkflowGraphState,
    node: WorkflowNode,
    result: unknown,
    outcome: WorkflowTransitionOutcome,
  ) => readonly WorkflowEdge[];
}

type ActivationCandidate =
  | { readonly kind: "ready"; readonly plan: Exclude<WorkflowStepPlan, { readonly kind: "wait" }> }
  | { readonly kind: "blocked"; readonly reason: WorkflowBlockedReason };

export function planWorkflowStep(input: WorkflowPlannerInput): WorkflowStepPlan {
  const { state } = input;
  if (state.nodeRuns > state.definition.limits.maxNodeRuns) {
    return {
      kind: "fail-workflow",
      failure: {
        code: "workflow_exhausted",
        message: `Workflow exceeded ${state.definition.limits.maxNodeRuns} node activations`,
        retryable: false,
      },
    };
  }
  if (state.active.length === 0) {
    return {
      kind: "fail-workflow",
      failure: {
        code: "workflow_invalid",
        message: "Workflow has no active or terminal node",
        retryable: false,
      },
    };
  }

  const blocked: {
    activationId: string;
    nodeId: string;
    reason: WorkflowBlockedReason;
  }[] = [];
  for (const activation of orderedActivations(state.active)) {
    const candidate = planActivation(input, activation);
    if (candidate.kind === "ready") return candidate.plan;
    blocked.push({
      activationId: activation.activationId,
      nodeId: activation.nodeId,
      reason: candidate.reason,
    });
  }
  return { kind: "wait", blocked };
}

function planActivation(
  input: WorkflowPlannerInput,
  activation: WorkflowActivation,
): ActivationCandidate {
  const node = requireNode(input.state, activation.nodeId);
  const base = { activationId: activation.activationId, node };
  switch (node.kind) {
    case "local":
      return { kind: "ready", plan: { kind: "run-local", ...base, node } };
    case "decision":
      return { kind: "ready", plan: { kind: "evaluate-decision", ...base, node } };
    case "invoke":
      return planInvoke(input, activation, node);
    case "join":
      return planJoin(input, activation, node);
    case "return":
      return planReturn(input, activation, node);
    case "fail":
      return { kind: "ready", plan: { kind: "fail-node", ...base, node } };
  }
  return assertNever(node);
}

function planInvoke(
  input: WorkflowPlannerInput,
  activation: WorkflowActivation,
  node: InvokeNode,
): ActivationCandidate {
  const base = { activationId: activation.activationId, node };
  const attempts = invocationAttempts(input.children, node.id, activation.activationId);
  const child = latestAttempt(attempts);
  if (!child) {
    return input.activeAttachedChildren < input.state.definition.limits.maxParallelism
      ? { kind: "ready", plan: { kind: "start-child", ...base } }
      : { kind: "blocked", reason: "parallelism-limit" };
  }
  if (!isTerminalRunState(child.state) || child.outcome === undefined) {
    return { kind: "blocked", reason: "child-running" };
  }
  if (shouldRetry(node, attempts, child)) {
    return input.activeAttachedChildren < input.state.definition.limits.maxParallelism
      ? { kind: "ready", plan: { kind: "retry-child", ...base, child } }
      : { kind: "blocked", reason: "parallelism-limit" };
  }

  const status = child.outcome.status;
  if (
    status !== "success" &&
    input.selectEdges(input.state, node, child.outcome, status).length === 0
  ) {
    return {
      kind: "ready",
      plan: { kind: "fail-workflow", failure: childFailure(child, child.outcome) },
    };
  }
  return { kind: "ready", plan: { kind: "complete-invoke", ...base, child } };
}

function planJoin(
  input: WorkflowPlannerInput,
  activation: WorkflowActivation,
  node: JoinNode,
): ActivationCandidate {
  const incoming = input.state.definition.graph.edges.filter((edge) => edge.to === node.id);
  const arrived = incoming.filter(
    (edge) => (input.state.context.transitionCounts.get(`${edge.from}->${edge.to}`) ?? 0) > 0,
  );
  const statuses = arrived.map((edge) => sourceStatus(input.state, edge.from));
  const successes = statuses.filter((status) => status === "success").length;
  const failures = statuses.filter((status) => status === "failure").length;
  const settled = statuses.filter((status) => status !== "pending").length;
  const quorum = node.quorum ?? Math.max(1, Math.ceil(incoming.length / 2));

  if (node.policy === "all-success" && failures > 0) {
    return {
      kind: "ready",
      plan: {
        kind: "fail-workflow",
        failure: {
          code: "workflow_rejected",
          message: `Join ${node.id} observed a failed required branch`,
          retryable: false,
        },
      },
    };
  }

  const satisfied =
    node.policy === "first-success"
      ? successes > 0
      : node.policy === "quorum"
        ? successes >= quorum
        : arrived.length === incoming.length && settled === incoming.length;
  if (!satisfied) return { kind: "blocked", reason: "join-incomplete" };

  return {
    kind: "ready",
    plan: {
      kind: "complete-join",
      activationId: activation.activationId,
      node,
      result: Object.fromEntries(
        incoming.map((edge) => [edge.from, input.state.context.results.get(edge.from) ?? []]),
      ),
    },
  };
}

function planReturn(
  input: WorkflowPlannerInput,
  activation: WorkflowActivation,
  node: ReturnNode,
): ActivationCandidate {
  if (input.activeAttachedChildren > 0) {
    return { kind: "blocked", reason: "attached-children" };
  }
  const failedChild = input.children.find(
    (child) =>
      child.ownership === "attached" &&
      child.outcome !== undefined &&
      child.outcome.status !== "success" &&
      !isHandledChildOutcome(input.state, input.children, child),
  );
  if (failedChild?.outcome) {
    return {
      kind: "ready",
      plan: { kind: "fail-workflow", failure: childFailure(failedChild, failedChild.outcome) },
    };
  }
  return {
    kind: "ready",
    plan: { kind: "complete-return", activationId: activation.activationId, node },
  };
}

function invocationAttempts(
  children: readonly RunRecord[],
  nodeId: string,
  activationId: string,
): readonly RunRecord[] {
  return children
    .filter((candidate) => {
      const causation = candidate.compiled.invocation.causation;
      return causation?.activationId === activationId && causation.nodeId === nodeId;
    })
    .sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id),
    );
}

function latestAttempt(attempts: readonly RunRecord[]): RunRecord | undefined {
  if (attempts.length === 0) return undefined;
  const superseded = new Set(
    attempts.flatMap((attempt) =>
      attempt.compiled.invocation.retryOf ? [attempt.compiled.invocation.retryOf] : [],
    ),
  );
  const tips = attempts.filter((attempt) => !superseded.has(attempt.id));
  return (tips.length > 0 ? tips : attempts).at(-1);
}

function shouldRetry(node: InvokeNode, attempts: readonly RunRecord[], child: RunRecord): boolean {
  if (!node.retry || node.wait === "background") return false;
  if (attempts.length - 1 >= node.retry.maxRetries) return false;
  return child.outcome?.status === "failure" && child.outcome.failure.retryable;
}

function sourceStatus(
  state: WorkflowGraphState,
  sourceNodeId: string,
): "pending" | "success" | "failure" {
  const source = requireNode(state, sourceNodeId);
  const result = state.context.latest.get(sourceNodeId);
  if (result === undefined) return "pending";
  if (source.kind !== "invoke") return "success";
  const outcome = result as Outcome<unknown>;
  return outcome.status === "success" ? "success" : "failure";
}

function isHandledChildOutcome(
  state: WorkflowGraphState,
  children: readonly RunRecord[],
  child: RunRecord,
): boolean {
  const causation = child.compiled.invocation.causation;
  const status = child.outcome?.status;
  if (!causation || !status || status === "success") return false;
  if (children.some((candidate) => candidate.compiled.invocation.retryOf === child.id)) return true;
  const source = requireNode(state, causation.nodeId);
  if (source.kind !== "invoke" || source.wait === "background") return false;
  return state.definition.graph.edges.some(
    (edge) =>
      edge.from === causation.nodeId &&
      matchesOutcome(edge, status) &&
      (state.context.transitionCounts.get(`${edge.from}->${edge.to}`) ?? 0) > 0,
  );
}

function orderedActivations(
  activations: readonly WorkflowActivation[],
): readonly WorkflowActivation[] {
  return [...activations].sort(
    (left, right) =>
      left.enteredSequence - right.enteredSequence ||
      left.activationId.localeCompare(right.activationId),
  );
}

function requireNode(state: WorkflowGraphState, nodeId: string): WorkflowNode {
  const node = state.definition.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Unknown workflow node ${state.definition.id}/${nodeId}`);
  return node;
}

function matchesOutcome(edge: WorkflowEdge, outcome: WorkflowTransitionOutcome): boolean {
  const accepted = edge.on ?? "success";
  return accepted === "any" || accepted === outcome;
}

function childFailure(child: RunRecord, outcome: Outcome<unknown>): Failure {
  if (outcome.status === "failure") {
    return { ...outcome.failure, retryable: false, causeRunId: child.id };
  }
  if (outcome.status === "cancelled") {
    return {
      code: "cancelled",
      message: `Child ${child.id} was cancelled: ${outcome.reason}`,
      retryable: false,
      causeRunId: child.id,
    };
  }
  return {
    code: "workflow_exhausted",
    message: `Child ${child.id} did not provide a usable outcome`,
    retryable: false,
    causeRunId: child.id,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported workflow node: ${JSON.stringify(value)}`);
}
