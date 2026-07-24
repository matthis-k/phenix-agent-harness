import type {
  PureConditionRef,
  PureDecisionRef,
  ValueMappingRef,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "../definition/definition.ts";

export interface WorkflowDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly nodeId?: string;
  readonly message: string;
}

export interface WorkflowFunctionInventory {
  hasMapping(ref: ValueMappingRef): boolean;
  hasDecision(ref: PureDecisionRef): boolean;
  hasCondition(ref: PureConditionRef): boolean;
  hasOperation(ref: string): boolean;
  hasDefinition(id: string): boolean;
}

type EdgeIndex = ReadonlyMap<string, readonly WorkflowEdge[]>;
type MappingRefs = Map<string, { readonly nodeId: string; readonly ref: string }>;

interface WorkflowTopology {
  readonly nodeById: ReadonlyMap<string, WorkflowNode>;
  readonly outgoing: EdgeIndex;
  readonly incoming: EdgeIndex;
}

const LIMIT_RULES = [
  [
    "timeout_invalid",
    "timeoutMs must be finite and non-negative",
    (definition: WorkflowDefinition<unknown, unknown>) => definition.limits.timeoutMs,
    (value: number) => Number.isFinite(value) && value >= 0,
  ],
  [
    "node_limit_invalid",
    "maxNodeRuns must be a positive integer",
    (definition: WorkflowDefinition<unknown, unknown>) => definition.limits.maxNodeRuns,
    isPositiveInteger,
  ],
  [
    "parallelism_invalid",
    "maxParallelism must be a positive integer",
    (definition: WorkflowDefinition<unknown, unknown>) => definition.limits.maxParallelism,
    isPositiveInteger,
  ],
] as const;

function diagnostic(
  code: string,
  message: string,
  nodeId?: string,
  severity: "error" | "warning" = "error",
): WorkflowDiagnostic {
  return { severity, code, message, ...(nodeId ? { nodeId } : {}) };
}

export function validateWorkflow(
  definition: WorkflowDefinition<unknown, unknown>,
  inventory: WorkflowFunctionInventory,
): WorkflowDiagnostic[] {
  const { graph } = definition;
  const diagnostics = validateLimits(definition);
  const topology = buildTopology(graph);
  const nodeIds = new Set<string>();
  const inputMappings: MappingRefs = new Map();
  const outputMappings: MappingRefs = new Map();

  for (const node of graph.nodes) {
    const hasInputMapping = node.kind === "invoke" || node.kind === "local";
    const outputMapping =
      node.kind === "return" ? node.output : node.kind === "fail" ? node.reason : undefined;

    if (nodeIds.has(node.id)) {
      diagnostics.push(diagnostic("duplicate_node", `Duplicate node ${node.id}`, node.id));
    }
    nodeIds.add(node.id);

    if (node.kind === "invoke") {
      if (!inventory.hasDefinition(node.definition.id)) {
        diagnostics.push(
          diagnostic(
            "definition_missing",
            `Unknown invoked definition ${node.definition.id}`,
            node.id,
          ),
        );
      }
      const invalidDepth =
        node.capabilityOverride?.maxDepth !== undefined &&
        (!Number.isInteger(node.capabilityOverride.maxDepth) ||
          node.capabilityOverride.maxDepth < 0);
      if (invalidDepth) {
        diagnostics.push(
          diagnostic("capability_invalid", "Capability maxDepth must be non-negative", node.id),
        );
      }
      for (const definitionId of node.capabilityOverride?.invokableDefinitions ?? []) {
        if (!inventory.hasDefinition(definitionId)) {
          diagnostics.push(
            diagnostic(
              "capability_definition_missing",
              `Unknown capability definition ${definitionId}`,
              node.id,
            ),
          );
        }
      }
    }

    if (hasInputMapping) {
      if (inventory.hasMapping(node.input)) {
        inputMappings.set(node.id, { nodeId: node.id, ref: node.input as string });
      } else {
        diagnostics.push(diagnostic("mapping_missing", `Unknown mapping ${node.input}`, node.id));
      }
    }
    if (outputMapping) {
      if (inventory.hasMapping(outputMapping)) {
        outputMappings.set(node.id, { nodeId: node.id, ref: outputMapping as string });
      } else {
        diagnostics.push(
          diagnostic("mapping_missing", `Unknown mapping ${outputMapping}`, node.id),
        );
      }
    }
    if (node.kind === "decision" && !inventory.hasDecision(node.decide)) {
      diagnostics.push(diagnostic("decision_missing", `Unknown decision ${node.decide}`, node.id));
    }
    if (node.kind === "local" && !inventory.hasOperation(node.operation)) {
      diagnostics.push(diagnostic("operation_missing", `Unknown operation ${node.operation}`, node.id));
    }
    if (node.kind === "join" && node.policy === "quorum" && (!node.quorum || node.quorum < 1)) {
      diagnostics.push(diagnostic("join_invalid", "Quorum joins require quorum >= 1", node.id));
    }
  }

  if (!nodeIds.has(graph.entry)) {
    diagnostics.push(diagnostic("entry_missing", `Unknown entry ${graph.entry}`));
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) {
      diagnostics.push(diagnostic("edge_source_missing", `Unknown edge source ${edge.from}`));
    }
    if (!nodeIds.has(edge.to)) {
      diagnostics.push(diagnostic("edge_target_missing", `Unknown edge target ${edge.to}`));
    }
    if (edge.when && !inventory.hasCondition(edge.when)) {
      diagnostics.push(diagnostic("condition_missing", `Unknown condition ${edge.when}`, edge.from));
    }
    const invalidTraversalLimit =
      edge.maxTraversals !== undefined &&
      (!Number.isInteger(edge.maxTraversals) || edge.maxTraversals < 1);
    if (invalidTraversalLimit) {
      diagnostics.push(
        diagnostic("traversal_invalid", "maxTraversals must be positive", edge.from),
      );
    }
  }

  for (const node of graph.nodes) {
    const incomingCount = topology.incoming.get(node.id)?.length ?? 0;
    const excessiveQuorum =
      node.kind === "join" &&
      node.policy === "quorum" &&
      node.quorum !== undefined &&
      node.quorum > incomingCount;
    if (excessiveQuorum) {
      diagnostics.push(
        diagnostic(
          "join_invalid",
          `Join quorum ${node.quorum} exceeds ${incomingCount} incoming edge(s)`,
          node.id,
        ),
      );
    }
  }

  const reachable = reachableNodes([graph.entry], topology.outgoing);
  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      diagnostics.push(diagnostic("node_unreachable", `Node ${nodeId} is unreachable`, nodeId));
    }
  }

  const terminals = graph.nodes.filter((node) => node.kind === "return" || node.kind === "fail");
  if (terminals.length === 0) {
    diagnostics.push(diagnostic("terminal_missing", "Workflow has no terminal node"));
  }
  const canReachTerminal = reachableNodes(
    terminals.map((node) => node.id),
    topology.incoming,
  );
  for (const nodeId of reachable) {
    if (!canReachTerminal.has(nodeId)) {
      diagnostics.push(
        diagnostic("no_terminal_path", `Node ${nodeId} cannot reach a terminal`, nodeId),
      );
    }
  }

  for (const edge of graph.edges) {
    const unboundedCycle =
      edge.maxTraversals === undefined && canReach(edge.to, edge.from, topology.outgoing, new Set());
    if (unboundedCycle) {
      diagnostics.push(
        diagnostic(
          "cycle_unbounded",
          `Cycle edge ${edge.from} -> ${edge.to} requires maxTraversals`,
          edge.from,
        ),
      );
    }
  }

  diagnostics.push(
    ...checkMappingsTypeConsistency(topology, inputMappings, outputMappings),
  );

  const fanOut = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.when) fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
  }
  for (const [nodeId, count] of fanOut) {
    if (count > definition.limits.maxParallelism) {
      diagnostics.push(
        diagnostic(
          "parallelism_exceeded",
          `Node ${nodeId} fans out to ${count}, above maxParallelism ${definition.limits.maxParallelism}`,
          nodeId,
        ),
      );
    }
  }

  return diagnostics;
}

function validateLimits(
  definition: WorkflowDefinition<unknown, unknown>,
): WorkflowDiagnostic[] {
  return LIMIT_RULES.flatMap(([code, message, read, valid]) =>
    valid(read(definition)) ? [] : [diagnostic(code, message)],
  );
}

function buildTopology(graph: WorkflowGraph<unknown, unknown>): WorkflowTopology {
  return {
    nodeById: new Map(graph.nodes.map((node) => [node.id, node])),
    outgoing: indexEdges(graph.edges, "from"),
    incoming: indexEdges(graph.edges, "to"),
  };
}

function indexEdges(edges: readonly WorkflowEdge[], side: "from" | "to"): EdgeIndex {
  const index = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const key = edge[side];
    const indexed = index.get(key) ?? [];
    indexed.push(edge);
    index.set(key, indexed);
  }
  return index;
}

function reachableNodes(seeds: readonly string[], adjacency: EdgeIndex): Set<string> {
  const result = new Set<string>();
  const pending = [...seeds];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || result.has(nodeId)) continue;
    result.add(nodeId);
    for (const edge of adjacency.get(nodeId) ?? []) {
      pending.push(edge.from === nodeId ? edge.to : edge.from);
    }
  }
  return result;
}

function canReach(
  current: string,
  target: string,
  outgoing: EdgeIndex,
  visited: Set<string>,
): boolean {
  if (current === target) return true;
  if (visited.has(current)) return false;
  visited.add(current);
  return (outgoing.get(current) ?? []).some((edge) =>
    canReach(edge.to, target, outgoing, visited),
  );
}

function checkMappingsTypeConsistency(
  topology: WorkflowTopology,
  inputMappings: MappingRefs,
  outputMappings: MappingRefs,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const [sourceId, outputRef] of outputMappings) {
    for (const targetId of downstreamNodes(sourceId, topology.outgoing)) {
      const mappingRef = inputMappings.get(targetId);
      const sameKind = topology.nodeById.get(sourceId)?.kind === topology.nodeById.get(targetId)?.kind;
      const suspiciousMapping = mappingRef && outputRef.ref === mappingRef.ref && sameKind;
      if (!suspiciousMapping) continue;
      diagnostics.push(
        diagnostic(
          "mapping_type_suspicious",
          `Node ${targetId} uses mapping "${mappingRef.ref}" which is the same ref used as output of node ${sourceId};` +
            " data may be passed through unchanged but the mapping identity suggests the workflow output feeds directly" +
            " into the next node without a typed transformation",
          targetId,
          "warning",
        ),
      );
    }
  }
  return diagnostics;
}

function downstreamNodes(nodeId: string, outgoing: EdgeIndex, visited = new Set<string>()): string[] {
  if (visited.has(nodeId)) return [];
  visited.add(nodeId);
  return (outgoing.get(nodeId) ?? []).flatMap((edge) => [
    edge.to,
    ...downstreamNodes(edge.to, outgoing, visited),
  ]);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}
