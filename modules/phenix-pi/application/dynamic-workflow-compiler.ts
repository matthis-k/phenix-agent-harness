import { createHash } from "node:crypto";

import {
  type DynamicValueBinding,
  type DynamicWorkflowNodeProposal,
  type DynamicWorkflowProposal,
  DynamicWorkflowProposalSchema,
} from "../definitions/dynamic-workflow.ts";
import {
  type AnyDefinition,
  definitionRef,
  type ValueMappingRef,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "../domain/definition/definition.ts";
import type { Schema } from "../domain/definition/schema.ts";
import { type DefinitionId, definitionId } from "../domain/shared.ts";
import type { ValueMapping } from "../domain/workflow/functions.ts";
import type { WorkflowEvaluationContext } from "../domain/workflow/graph-state.ts";
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

    if (
      containsCycle(
        proposal.nodes.map((node) => node.id),
        outgoing,
      )
    ) {
      throw new DynamicWorkflowCompileError(
        "Dynamic workflows are initially restricted to acyclic graphs",
      );
    }

    const invokedDefinitions = resolveInvokedDefinitions(
      proposal,
      allowed,
      this.bindings.resolveDefinition.bind(this.bindings),
    );
    const invocationSchemas = resolveInvocationSchemas(
      proposal,
      invokedDefinitions,
      this.bindings.resolveSchema.bind(this.bindings),
    );
    validateBindings(proposal, proposalNodes, outgoing, invokedDefinitions, invocationSchemas);

    const inputSchema = this.bindings.resolveSchema(proposal.inputSchema);
    const outputSchema = this.bindings.resolveSchema(proposal.outputSchema);
    const identity = dynamicWorkflowIdentity(
      proposal,
      [...invokedDefinitions.values()],
      [inputSchema, outputSchema, ...invocationSchemas.values()],
    );
    const id = definitionId(`workflow.dynamic.${identity.graphDigest.slice(0, 24)}`);
    const mappings = new Map<ValueMappingRef, ValueMapping>();
    const nodes = proposal.nodes.map((node) =>
      compileNode(id, node, invokedDefinitions, invocationSchemas, mappings),
    );
    const edges: readonly WorkflowEdge[] = proposal.edges.map((edge) => ({ ...edge }));
    const definition: WorkflowDefinition<unknown, unknown> = {
      id,
      kind: "workflow",
      title: proposal.title,
      description: proposal.description,
      input: inputSchema,
      output: outputSchema,
      graph: { entry: proposal.entry, nodes, edges },
      limits: proposal.limits,
    };

    const diagnostics = validateWorkflow(
      definition,
      dynamicInventory(invokedDefinitions, mappings),
    );
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

function resolveInvokedDefinitions(
  proposal: DynamicWorkflowProposal,
  allowed: ReadonlySet<string>,
  resolve: (id: DefinitionId) => AnyDefinition,
): ReadonlyMap<string, AnyDefinition> {
  const definitions = new Map<string, AnyDefinition>();
  for (const node of proposal.nodes) {
    if (node.kind !== "invoke") continue;
    let id: DefinitionId;
    try {
      id = definitionId(node.definitionId);
    } catch (error) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow node ${node.id} has invalid definition ID: ${describeError(error)}`,
      );
    }
    if (!allowed.has(id)) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow node ${node.id} references unavailable definition ${id}`,
      );
    }
    definitions.set(node.id, resolve(id));
  }
  return definitions;
}

function resolveInvocationSchemas(
  proposal: DynamicWorkflowProposal,
  definitions: ReadonlyMap<string, AnyDefinition>,
  resolveSchema: (id: string) => Schema<unknown>,
): ReadonlyMap<string, Schema<unknown>> {
  const schemas = new Map<string, Schema<unknown>>();
  for (const node of proposal.nodes) {
    if (node.kind !== "invoke") continue;
    const definition = definitions.get(node.id);
    if (!definition) throw new DynamicWorkflowCompileError(`Missing resolved node ${node.id}`);
    const isStock = definition.kind === "agent" && definition.sessionMode === "stock";
    if (isStock) {
      if (!node.outputSchema) {
        throw new DynamicWorkflowCompileError(
          `Dynamic workflow node ${node.id} must declare outputSchema for ${definition.id}`,
        );
      }
      const schema = resolveSchema(node.outputSchema);
      if (schema.id === definition.output.id) {
        throw new DynamicWorkflowCompileError(
          `Dynamic workflow node ${node.id} must bind a concrete output schema for ${definition.id}`,
        );
      }
      schemas.set(node.id, schema);
      continue;
    }
    if (node.outputSchema && node.outputSchema !== definition.output.id) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow node ${node.id} may not override fixed output schema ${definition.output.id}`,
      );
    }
    schemas.set(node.id, definition.output);
  }
  return schemas;
}

function validateBindings(
  proposal: DynamicWorkflowProposal,
  nodes: ReadonlyMap<string, DynamicWorkflowNodeProposal>,
  outgoing: ReadonlyMap<string, readonly string[]>,
  definitions: ReadonlyMap<string, AnyDefinition>,
  invocationSchemas: ReadonlyMap<string, Schema<unknown>>,
): void {
  for (const node of proposal.nodes) {
    const binding =
      node.kind === "invoke" ? node.input : node.kind === "return" ? node.output : undefined;
    if (!binding) continue;
    assertDynamicBinding(binding, `node ${node.id} binding`);
    validateBindingReferences(binding, node.id, nodes, outgoing);
    const expectedSchema =
      node.kind === "invoke" ? definitions.get(node.id)?.input.id : proposal.outputSchema;
    const actualSchema = directBindingSchema(binding, proposal, invocationSchemas);
    if (expectedSchema && actualSchema && expectedSchema !== actualSchema) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow node ${node.id} passes complete schema ${actualSchema} to ${expectedSchema}`,
      );
    }
  }
}

function compileNode(
  workflowId: DefinitionId,
  proposal: DynamicWorkflowNodeProposal,
  definitions: ReadonlyMap<string, AnyDefinition>,
  invocationSchemas: ReadonlyMap<string, Schema<unknown>>,
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

  const direction = proposal.kind === "return" ? "output" : "input";
  const ref = `${workflowId}.mapping.${proposal.id}.${direction}`;
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

  const definition = definitions.get(proposal.id);
  const outputSchema = invocationSchemas.get(proposal.id);
  if (!definition || !outputSchema) {
    throw new DynamicWorkflowCompileError(`Missing resolved node ${proposal.id}`);
  }
  const isStock = definition.kind === "agent" && definition.sessionMode === "stock";
  return {
    kind: "invoke",
    id: proposal.id,
    ...(proposal.title ? { title: proposal.title } : {}),
    definition: definitionRef(definition.id),
    input: ref,
    wait: "await",
    ...(isStock ? { outputSchema: outputSchema.id } : {}),
    ...(proposal.retry
      ? { retry: { when: "retryable" as const, maxRetries: proposal.retry.maxRetries } }
      : {}),
  };
}

function dynamicInventory(
  definitions: ReadonlyMap<string, AnyDefinition>,
  mappings: ReadonlyMap<ValueMappingRef, ValueMapping>,
): WorkflowFunctionInventory {
  const definitionIds = new Set([...definitions.values()].map((definition) => definition.id));
  return {
    hasMapping: (ref) => mappings.has(ref),
    hasDecision: () => false,
    hasCondition: () => false,
    hasOperation: () => false,
    hasDefinition: (candidate) => definitionIds.has(candidate as DefinitionId),
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
    binding.source === "input" ? context.input : requireNodeResult(context.latest, binding.nodeId);
  return readPath(root, binding.path ?? []);
}

function assertDynamicBinding(
  value: unknown,
  location: string,
  depth = 0,
): asserts value is DynamicValueBinding {
  if (depth > 16) {
    throw new DynamicWorkflowCompileError(`${location} exceeds maximum binding depth 16`);
  }
  if (!isRecord(value)) {
    throw new DynamicWorkflowCompileError(`${location} must be an object`);
  }

  const source = value.source;
  if (source === "input") {
    assertOnlyKeys(value, ["source", "path"], location);
    assertBindingPath(value.path, location);
    return;
  }
  if (source === "node") {
    assertOnlyKeys(value, ["source", "nodeId", "path"], location);
    if (!validIdentifier(value.nodeId)) {
      throw new DynamicWorkflowCompileError(`${location}.nodeId must be a valid identifier`);
    }
    assertBindingPath(value.path, location);
    return;
  }
  if (source === "literal") {
    assertOnlyKeys(value, ["source", "value"], location);
    if (!Object.hasOwn(value, "value")) {
      throw new DynamicWorkflowCompileError(`${location}.value is required`);
    }
    return;
  }
  if (source === "object") {
    assertOnlyKeys(value, ["source", "fields"], location);
    if (!isRecord(value.fields)) {
      throw new DynamicWorkflowCompileError(`${location}.fields must be an object`);
    }
    const entries = Object.entries(value.fields);
    if (entries.length > 64) {
      throw new DynamicWorkflowCompileError(`${location}.fields exceeds maximum size 64`);
    }
    for (const [key, nested] of entries) {
      if (!validIdentifier(key)) {
        throw new DynamicWorkflowCompileError(`${location}.fields has invalid key ${key}`);
      }
      assertDynamicBinding(nested, `${location}.fields.${key}`, depth + 1);
    }
    return;
  }
  if (source === "array") {
    assertOnlyKeys(value, ["source", "items"], location);
    if (!Array.isArray(value.items) || value.items.length > 64) {
      throw new DynamicWorkflowCompileError(`${location}.items must contain at most 64 bindings`);
    }
    value.items.forEach((nested, index) => {
      assertDynamicBinding(nested, `${location}.items.${index}`, depth + 1);
    });
    return;
  }
  throw new DynamicWorkflowCompileError(`${location}.source is unsupported`);
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new DynamicWorkflowCompileError(`${location} contains unexpected property ${unexpected}`);
  }
}

function assertBindingPath(value: unknown, location: string): void {
  if (value === undefined) return;
  const valid =
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every(
      (segment) => typeof segment === "string" && segment.length >= 1 && segment.length <= 96,
    );
  if (!valid) {
    throw new DynamicWorkflowCompileError(`${location}.path must contain at most 16 path segments`);
  }
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
  invocationSchemas: ReadonlyMap<string, Schema<unknown>>,
): string | undefined {
  if (binding.source === "input") {
    return binding.path?.length ? undefined : proposal.inputSchema;
  }
  if (binding.source === "node") {
    return binding.path?.length ? undefined : invocationSchemas.get(binding.nodeId)?.id;
  }
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
    [...new Map(schemas.map((schema) => [schema.id, schema] as const)).values()]
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
    sessionMode: definition.sessionMode ?? "phenix",
    model: definition.model,
    modelRoutes: definition.modelRoutes,
    thinking: definition.thinking,
    prompt: definition.sessionMode === "stock" ? undefined : definition.prompt.render(),
    tools: definition.tools,
    context: definition.context,
    childCapabilities: definition.childCapabilities,
    limits: definition.limits,
    persistence: definition.persistence,
  };
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

function containsCycle(
  nodeIds: readonly string[],
  outgoing: ReadonlyMap<string, readonly string[]>,
): boolean {
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
  return nodeIds.some(visit);
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 96 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
