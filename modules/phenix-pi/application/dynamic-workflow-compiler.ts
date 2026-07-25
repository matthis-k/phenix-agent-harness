import { createHash } from "node:crypto";

import {
  type DynamicValueBinding,
  type DynamicWorkflowNodeProposal,
  type DynamicWorkflowProposal,
  DynamicWorkflowProposalSchema,
} from "../definitions/dynamic-workflow.ts";
import {
  type AgentDefinition,
  type AnyDefinition,
  definitionRef,
  type ValueMappingRef,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "../domain/definition/definition.ts";
import type { Schema } from "../domain/definition/schema.ts";
import { definitionId, type DefinitionId } from "../domain/shared.ts";
import type { WorkflowEvaluationContext } from "../domain/workflow/graph-state.ts";
import type { ValueMapping } from "../domain/workflow/functions.ts";
import {
  validateWorkflow,
  type WorkflowDiagnostic,
  type WorkflowFunctionInventory,
} from "../domain/workflow/validator.ts";

export interface DynamicWorkflowIdentity {
  readonly version: 1;
  readonly graphDigest: string;
  readonly definitionDigests: Readonly<Record<string, string>>;
  readonly schemaDigests: Readonly<Record<string, string>>;
}

export interface CompiledDynamicWorkflow {
  readonly definition: WorkflowDefinition<unknown, unknown>;
  readonly mappings: ReadonlyMap<ValueMappingRef, ValueMapping>;
  readonly identity: DynamicWorkflowIdentity;
  readonly proposal: DynamicWorkflowProposal;
}

export interface DynamicWorkflowCompilerBindings {
  resolveDefinition(id: DefinitionId): AnyDefinition;
  resolveSchema(id: string): Schema<unknown>;
}

export interface DynamicWorkflowCompileOptions {
  readonly allowedDefinitionIds: readonly DefinitionId[];
}

export class DynamicWorkflowCompileError extends Error {
  readonly diagnostics: readonly WorkflowDiagnostic[];

  constructor(message: string, diagnostics: readonly WorkflowDiagnostic[] = []) {
    super(message);
    this.name = "DynamicWorkflowCompileError";
    this.diagnostics = diagnostics;
  }
}

export class DynamicWorkflowCompiler {
  private readonly bindings: DynamicWorkflowCompilerBindings;

  constructor(bindings: DynamicWorkflowCompilerBindings) {
    this.bindings = bindings;
  }

  compile(raw: unknown, options: DynamicWorkflowCompileOptions): CompiledDynamicWorkflow {
    const validated = DynamicWorkflowProposalSchema.validate(raw);
    if (!validated.ok) {
      throw new DynamicWorkflowCompileError(
        `Invalid dynamic workflow proposal: ${validated.issues
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("; ")}`,
      );
    }

    const proposal = normalizeProposal(validated.value);
    const allowed = new Set<string>(options.allowedDefinitionIds);
    const proposalNodes = new Map(proposal.nodes.map((node) => [node.id, node] as const));
    const outgoing = indexEdges(proposal.edges);

    if (containsCycle(proposal.entry, outgoing)) {
      throw new DynamicWorkflowCompileError(
        "Dynamic workflows are initially restricted to acyclic graphs",
      );
    }

    const invokedDefinitions = new Map<string, AnyDefinition>();
    for (const node of proposal.nodes) {
      if (node.kind !== "invoke") continue;
      const id = definitionId(node.definitionId);
      if (!allowed.has(id)) {
        throw new DynamicWorkflowCompileError(
          `Dynamic workflow node ${node.id} references unavailable definition ${id}`,
        );
      }
      invokedDefinitions.set(node.id, this.bindings.resolveDefinition(id));
    }

    for (const node of proposal.nodes) {
      const binding = node.kind === "invoke" ? node.input : node.kind === "return" ? node.output : undefined;
      if (!binding) continue;
      validateBindingReferences(binding, node.id, proposalNodes, outgoing);
      const expectedSchema =
        node.kind === "invoke"
          ? invokedDefinitions.get(node.id)?.input.id
          : proposal.outputSchema;
      const actualSchema = directBindingSchema(binding, proposal, invokedDefinitions);
      if (expectedSchema && actualSchema && expectedSchema !== actualSchema) {
        throw new DynamicWorkflowCompileError(
          `Dynamic workflow node ${node.id} passes complete schema ${actualSchema} to ${expectedSchema}`,
        );
      }
    }

    const inputSchema = this.bindings.resolveSchema(proposal.inputSchema);
    const outputSchema = this.bindings.resolveSchema(proposal.outputSchema);
    const identity = dynamicWorkflowIdentity(
      proposal,
      [...invokedDefinitions.values()],
      [inputSchema, outputSchema],
    );
    const id = definitionId(`workflow.dynamic.${identity.graphDigest.slice(0, 24)}`);
    const mappings = new Map<ValueMappingRef, ValueMapping>();
    const nodes = proposal.nodes.map((node) =>
      compileNode(id, node, invokedDefinitions, mappings),
    );
    const edges: readonly WorkflowEdge[] = proposal.edges.map((edge) => ({ ...edge }));
    const definition: WorkflowDefinition<unknown, unknown> = {
      id,
      kind: "workflow",
      title: proposal.title,
      description: proposal.description,
      input: inputSchema,
      output: outputSchema,
      graph: {
        entry: proposal.entry,
        nodes,
        edges,
      },
      limits: proposal.limits,
    };

    const inventory: WorkflowFunctionInventory = {
      hasMapping: (ref) => mappings.has(ref),
      hasDecision: () => false,
      hasCondition: () => false,
      hasOperation: () => false,
      hasDefinition: (candidate) =>
        [...invokedDefinitions.values()].some((definition) => definition.id === candidate),
    };
    const diagnostics = validateWorkflow(definition, inventory);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow failed validation: ${errors
          .map((diagnostic) => `[${diagnostic.code}] ${diagnostic.message}`)
          .join("; ")}`,
        diagnostics,
      );
    }

    return Object.freeze({
      definition: deepFreeze(definition),
      mappings,
      identity,
      proposal: deepFreeze(proposal),
    });
  }
}

function compileNode(
  workflowId: DefinitionId,
  proposal: DynamicWorkflowNodeProposal,
  invokedDefinitions: ReadonlyMap<string, AnyDefinition>,
  mappings: Map<ValueMappingRef, ValueMapping>,
): WorkflowNode {
  if (proposal.kind === "join") {
    return {
      kind: "join",
      id: proposal.id,
      ...(proposal.title ? { title: proposal.title } : {}),
      policy: proposal.policy,
      ...(proposal.quorum === undefined ? {} : { quorum: proposal.quorum }),
    };
  }

  const ref = `${workflowId}.mapping.${proposal.id}.${proposal.kind === "return" ? "output" : "input"}`;
  const binding = proposal.kind === "return" ? proposal.output : proposal.input;
  mappings.set(ref, (context) => evaluateDynamicBinding(binding, context));

  if (proposal.kind === "return") {
    return {
      kind: "return",
      id: proposal.id,
      ...(proposal.title ? { title: proposal.title } : {}),
      output: ref,
    };
  }

  const definition = invokedDefinitions.get(proposal.id);
  if (!definition) throw new DynamicWorkflowCompileError(`Missing resolved node ${proposal.id}`);
  return {
    kind: "invoke",
    id: proposal.id,
    ...(proposal.title ? { title: proposal.title } : {}),
    definition: definitionRef(definition.id),
    input: ref,
    wait: "await",
    ...(proposal.retry
      ? { retry: { when: "retryable" as const, maxRetries: proposal.retry.maxRetries } }
      : {}),
  };
}

export function evaluateDynamicBinding(
  binding: DynamicValueBinding,
  context: WorkflowEvaluationContext,
): unknown {
  if (binding.source === "literal") return binding.value;
  if (binding.source === "object") {
    return Object.fromEntries(
      Object.entries(binding.fields).map(([key, value]) => [
        key,
        evaluateDynamicBinding(value, context),
      ]),
    );
  }
  if (binding.source === "array") {
    return binding.items.map((item) => evaluateDynamicBinding(item, context));
  }

  const root =
    binding.source === "input"
      ? context.input
      : requireNodeResult(context.latest, binding.nodeId);
  return readPath(root, binding.path ?? []);
}

function validateBindingReferences(
  binding: DynamicValueBinding,
  targetNodeId: string,
  nodes: ReadonlyMap<string, DynamicWorkflowNodeProposal>,
  outgoing: ReadonlyMap<string, readonly string[]>,
): void {
  if (binding.source === "node") {
    const source = nodes.get(binding.nodeId);
    if (!source) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow node ${targetNodeId} references unknown result ${binding.nodeId}`,
      );
    }
    if (source.kind === "join" || source.kind === "return") {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow node ${targetNodeId} references resultless node ${binding.nodeId}`,
      );
    }
    if (binding.nodeId === targetNodeId || !canReach(binding.nodeId, targetNodeId, outgoing)) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow node ${targetNodeId} may only reference upstream node results; ${binding.nodeId} is not upstream`,
      );
    }
    return;
  }
  if (binding.source === "object") {
    for (const nested of Object.values(binding.fields)) {
      validateBindingReferences(nested, targetNodeId, nodes, outgoing);
    }
  }
  if (binding.source === "array") {
    for (const nested of binding.items) {
      validateBindingReferences(nested, targetNodeId, nodes, outgoing);
    }
  }
}

function directBindingSchema(
  binding: DynamicValueBinding,
  proposal: DynamicWorkflowProposal,
  invokedDefinitions: ReadonlyMap<string, AnyDefinition>,
): string | undefined {
  if ((binding.path?.length ?? 0) > 0) return undefined;
  if (binding.source === "input") return proposal.inputSchema;
  if (binding.source === "node") return invokedDefinitions.get(binding.nodeId)?.output.id;
  return undefined;
}

function requireNodeResult(latest: ReadonlyMap<string, unknown>, nodeId: string): unknown {
  if (!latest.has(nodeId)) throw new Error(`Dynamic workflow result ${nodeId} is not available`);
  return latest.get(nodeId);
}

function readPath(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !(segment in current)) {
      throw new Error(`Dynamic workflow binding path ${path.join(".")} is unavailable`);
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

function dynamicWorkflowIdentity(
  proposal: DynamicWorkflowProposal,
  definitions: readonly AnyDefinition[],
  schemas: readonly Schema<unknown>[],
): DynamicWorkflowIdentity {
  const definitionDigests = Object.fromEntries(
    [...definitions]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((definition) => [definition.id, digest(definitionContract(definition))]),
  );
  const schemaDigests = Object.fromEntries(
    [...schemas]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((schema) => [schema.id, digest(schema.jsonSchema)]),
  );
  const graphDigest = digest({ version: 1, proposal, definitionDigests, schemaDigests });
  return Object.freeze({ version: 1, graphDigest, definitionDigests, schemaDigests });
}

function definitionContract(definition: AnyDefinition): unknown {
  const common = {
    id: definition.id,
    kind: definition.kind,
    inputSchema: definition.input.id,
    outputSchema: definition.output.id,
    title: definition.title,
    description: definition.description,
  };
  if (definition.kind === "workflow") {
    return { ...common, graph: definition.graph, limits: definition.limits };
  }
  return {
    ...common,
    model: definition.model,
    modelRoutes: definition.modelRoutes,
    thinking: definition.thinking,
    prompt: definition.prompt.render(),
    tools: definition.tools,
    context: definition.context,
    childCapabilities: definition.childCapabilities,
    limits: definition.limits,
    persistence: definition.persistence,
  } satisfies Record<keyof AgentDefinition<unknown, unknown> | "inputSchema" | "outputSchema", unknown>;
}

function normalizeProposal(proposal: DynamicWorkflowProposal): DynamicWorkflowProposal {
  return {
    ...proposal,
    title: proposal.title.trim(),
    description: proposal.description.trim(),
    nodes: proposal.nodes.map((node) => ({
      ...node,
      ...(node.title ? { title: node.title.trim() } : {}),
    })),
    edges: proposal.edges.map((edge) => ({ ...edge })),
    limits: { ...proposal.limits },
  };
}

function indexEdges(
  edges: readonly { readonly from: string; readonly to: string }[],
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>();
  for (const edge of edges) {
    result.set(edge.from, [...(result.get(edge.from) ?? []), edge.to]);
  }
  return result;
}

function containsCycle(entry: string, outgoing: ReadonlyMap<string, readonly string[]>): boolean {
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): boolean => {
    if (active.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    active.add(nodeId);
    for (const target of outgoing.get(nodeId) ?? []) {
      if (visit(target)) return true;
    }
    active.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  return visit(entry);
}

function canReach(
  source: string,
  target: string,
  outgoing: ReadonlyMap<string, readonly string[]>,
  visited = new Set<string>(),
): boolean {
  if (source === target) return true;
  if (visited.has(source)) return false;
  visited.add(source);
  return (outgoing.get(source) ?? []).some((next) => canReach(next, target, outgoing, visited));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
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

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}
