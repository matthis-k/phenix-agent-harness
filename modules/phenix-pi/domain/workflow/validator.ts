import type {
  PureConditionRef,
  PureDecisionRef,
  ValueMappingRef,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowGraph,
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
  const graph = definition.graph;
  const diagnostics: WorkflowDiagnostic[] = [];
  const ids = new Set<string>();

  if (!Number.isFinite(definition.limits.timeoutMs) || definition.limits.timeoutMs < 0) {
    diagnostics.push(diagnostic("timeout_invalid", `timeoutMs must be finite and non-negative`));
  }
  if (!Number.isInteger(definition.limits.maxNodeRuns) || definition.limits.maxNodeRuns < 1) {
    diagnostics.push(diagnostic("node_limit_invalid", `maxNodeRuns must be a positive integer`));
  }
  if (!Number.isInteger(definition.limits.maxParallelism) || definition.limits.maxParallelism < 1) {
    diagnostics.push(
      diagnostic("parallelism_invalid", `maxParallelism must be a positive integer`),
    );
  }

  const nodeMappingRefs = new Map<string, { readonly nodeId: string; readonly ref: string }>();
  const nodeOutputRefs = new Map<string, { readonly nodeId: string; readonly ref: string }>();

  for (const node of graph.nodes) {
    if (ids.has(node.id))
      diagnostics.push(diagnostic("duplicate_node", `Duplicate node ${node.id}`, node.id));
    ids.add(node.id);

    if (node.kind === "invoke" && !inventory.hasDefinition(node.definition.id)) {
      diagnostics.push(
        diagnostic(
          "definition_missing",
          `Unknown invoked definition ${node.definition.id}`,
          node.id,
        ),
      );
    }
    if (node.kind === "invoke" && node.capabilityOverride) {
      if (
        node.capabilityOverride.maxDepth !== undefined &&
        (!Number.isInteger(node.capabilityOverride.maxDepth) ||
          node.capabilityOverride.maxDepth < 0)
      ) {
        diagnostics.push(
          diagnostic("capability_invalid", `Capability maxDepth must be non-negative`, node.id),
        );
      }
      for (const id of node.capabilityOverride.invokableDefinitions ?? []) {
        if (!inventory.hasDefinition(id)) {
          diagnostics.push(
            diagnostic(
              "capability_definition_missing",
              `Unknown capability definition ${id}`,
              node.id,
            ),
          );
        }
      }
    }
    if ((node.kind === "invoke" || node.kind === "local") && !inventory.hasMapping(node.input)) {
      diagnostics.push(diagnostic("mapping_missing", `Unknown mapping ${node.input}`, node.id));
    } else if (node.kind === "invoke" || node.kind === "local") {
      nodeMappingRefs.set(node.id, { nodeId: node.id, ref: node.input as string });
    }
    if (
      (node.kind === "return" || node.kind === "fail") &&
      !inventory.hasMapping(node.kind === "return" ? node.output : node.reason)
    ) {
      diagnostics.push(
        diagnostic(
          "mapping_missing",
          `Unknown mapping ${node.kind === "return" ? node.output : node.reason}`,
          node.id,
        ),
      );
    } else if (node.kind === "return" || node.kind === "fail") {
      nodeOutputRefs.set(node.id, {
        nodeId: node.id,
        ref: node.kind === "return" ? (node.output as string) : (node.reason as string),
      });
    }
    if (node.kind === "decision" && !inventory.hasDecision(node.decide)) {
      diagnostics.push(diagnostic("decision_missing", `Unknown decision ${node.decide}`, node.id));
    }
    if (node.kind === "local" && !inventory.hasOperation(node.operation)) {
      diagnostics.push(
        diagnostic("operation_missing", `Unknown operation ${node.operation}`, node.id),
      );
    }
    if (node.kind === "join" && node.policy === "quorum" && (!node.quorum || node.quorum < 1)) {
      diagnostics.push(diagnostic("join_invalid", `Quorum joins require quorum >= 1`, node.id));
    }
  }

  if (!ids.has(graph.entry))
    diagnostics.push(diagnostic("entry_missing", `Unknown entry ${graph.entry}`));

  for (const edge of graph.edges) {
    if (!ids.has(edge.from))
      diagnostics.push(diagnostic("edge_source_missing", `Unknown edge source ${edge.from}`));
    if (!ids.has(edge.to))
      diagnostics.push(diagnostic("edge_target_missing", `Unknown edge target ${edge.to}`));
    if (edge.when && !inventory.hasCondition(edge.when)) {
      diagnostics.push(
        diagnostic("condition_missing", `Unknown condition ${edge.when}`, edge.from),
      );
    }
    if (
      edge.maxTraversals !== undefined &&
      (!Number.isInteger(edge.maxTraversals) || edge.maxTraversals < 1)
    ) {
      diagnostics.push(
        diagnostic("traversal_invalid", `maxTraversals must be positive`, edge.from),
      );
    }
  }

  for (const node of graph.nodes) {
    if (node.kind !== "join" || node.policy !== "quorum" || node.quorum === undefined) continue;
    const incoming = graph.edges.filter((edge) => edge.to === node.id).length;
    if (node.quorum > incoming) {
      diagnostics.push(
        diagnostic(
          "join_invalid",
          `Join quorum ${node.quorum} exceeds ${incoming} incoming edge(s)`,
          node.id,
        ),
      );
    }
  }

  const reachable = reachableNodes(graph.entry, graph.edges);
  for (const id of ids) {
    if (!reachable.has(id))
      diagnostics.push(diagnostic("node_unreachable", `Node ${id} is unreachable`, id));
  }

  const terminals = graph.nodes.filter((node) => node.kind === "return" || node.kind === "fail");
  if (terminals.length === 0)
    diagnostics.push(diagnostic("terminal_missing", `Workflow has no terminal node`));
  const reverseReachable = reverseReachableNodes(
    terminals.map((node) => node.id),
    graph.edges,
  );
  for (const id of reachable) {
    if (!reverseReachable.has(id)) {
      diagnostics.push(diagnostic("no_terminal_path", `Node ${id} cannot reach a terminal`, id));
    }
  }

  for (const edge of cycleEdges(graph.edges)) {
    if (edge.maxTraversals === undefined) {
      diagnostics.push(
        diagnostic(
          "cycle_unbounded",
          `Cycle edge ${edge.from} -> ${edge.to} requires maxTraversals`,
          edge.from,
        ),
      );
    }
  }

  const mappingTypeDiagnostics = checkMappingsTypeConsistency(
    graph,
    nodeMappingRefs,
    nodeOutputRefs,
  );
  diagnostics.push(...mappingTypeDiagnostics);

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

function reachableNodes(entry: string, edges: readonly WorkflowEdge[]): Set<string> {
  const result = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || result.has(id)) continue;
    result.add(id);
    for (const edge of edges) if (edge.from === id) pending.push(edge.to);
  }
  return result;
}

function reverseReachableNodes(
  terminals: readonly string[],
  edges: readonly WorkflowEdge[],
): Set<string> {
  const result = new Set<string>();
  const pending = [...terminals];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || result.has(id)) continue;
    result.add(id);
    for (const edge of edges) if (edge.to === id) pending.push(edge.from);
  }
  return result;
}

function cycleEdges(edges: readonly WorkflowEdge[]): readonly WorkflowEdge[] {
  const output: WorkflowEdge[] = [];
  for (const edge of edges) {
    if (canReach(edge.to, edge.from, edges, new Set())) output.push(edge);
  }
  return output;
}

function canReach(
  current: string,
  target: string,
  edges: readonly WorkflowEdge[],
  visited: Set<string>,
): boolean {
  if (current === target) return true;
  if (visited.has(current)) return false;
  visited.add(current);
  return edges
    .filter((edge) => edge.from === current)
    .some((edge) => canReach(edge.to, target, edges, visited));
}

function checkMappingsTypeConsistency(
  graph: WorkflowGraph<unknown, unknown>,
  nodeMappingRefs: Map<string, { readonly nodeId: string; readonly ref: string }>,
  nodeOutputRefs: Map<string, { readonly nodeId: string; readonly ref: string }>,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const targets = outgoing.get(edge.from) ?? [];
    targets.push(edge.to);
    outgoing.set(edge.from, targets);
  }

  for (const [sourceId, outputRef] of nodeOutputRefs) {
    const downstream = downstreamNodes(sourceId, outgoing);
    for (const targetId of downstream) {
      const mappingRef = nodeMappingRefs.get(targetId);
      if (!mappingRef) continue;
      const sourceNode = nodeById.get(sourceId);
      const targetNode = nodeById.get(targetId);
      if (outputRef.ref === mappingRef.ref && sourceNode?.kind === targetNode?.kind) {
        diagnostics.push(
          diagnostic(
            "mapping_type_suspicious",
            `Node ${targetId} uses mapping "${mappingRef.ref}" which is the same ref used as output of node ${sourceId};` +
              ` data may be passed through unchanged but the mapping identity suggests the workflow output feeds directly` +
              ` into the next node without a typed transformation`,
            targetId,
            "warning",
          ),
        );
      }
    }
  }

  return diagnostics;
}

function downstreamNodes(
  nodeId: string,
  outgoing: Map<string, string[]>,
  visited?: Set<string>,
): string[] {
  const visitedSet = visited ?? new Set<string>();
  if (visitedSet.has(nodeId)) return [];
  visitedSet.add(nodeId);
  const result: string[] = [];
  const targets = outgoing.get(nodeId) ?? [];
  for (const target of targets) {
    result.push(target);
    result.push(...downstreamNodes(target, outgoing, visitedSet));
  }
  return result;
}
