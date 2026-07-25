import {
  type DynamicWorkflowProposal,
  DynamicWorkflowProposalSchema,
} from "../definitions/dynamic-workflow.ts";
import type { ValueMappingRef } from "../domain/definition/definition.ts";
import type {
  PersistedDynamicWorkflowIdentity,
  PersistedDynamicWorkflowSnapshot,
} from "../domain/run/model.ts";
import { type DefinitionId, definitionId } from "../domain/shared.ts";
import type { ValueMapping } from "../domain/workflow/functions.ts";
import type { WorkflowEvaluationContext } from "../domain/workflow/graph-state.ts";
import type { DefinitionCatalog, WorkflowFunctionRegistry } from "./catalog.ts";
import {
  type CompiledDynamicWorkflow,
  DynamicWorkflowCompileError,
  type DynamicWorkflowCompiler,
  type DynamicWorkflowIdentity,
} from "./dynamic-workflow-compiler.ts";

export interface DynamicWorkflowSnapshot extends PersistedDynamicWorkflowSnapshot {
  readonly proposal: DynamicWorkflowProposal;
  readonly identity: DynamicWorkflowIdentity;
}

export class DynamicWorkflowDriftError extends Error {
  readonly expected: PersistedDynamicWorkflowIdentity;
  readonly actual: DynamicWorkflowIdentity;

  constructor(expected: PersistedDynamicWorkflowIdentity, actual: DynamicWorkflowIdentity) {
    super(
      `Dynamic workflow ${expected.graphDigest} cannot be restored because its execution contract changed to ${actual.graphDigest}`,
    );
    this.name = "DynamicWorkflowDriftError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class DynamicWorkflowRuntimeRegistry {
  private readonly compiler: DynamicWorkflowCompiler;
  private readonly catalog: DefinitionCatalog;
  private readonly functions: WorkflowFunctionRegistry;
  private readonly identities = new Map<DefinitionId, DynamicWorkflowIdentity>();

  constructor(input: {
    readonly compiler: DynamicWorkflowCompiler;
    readonly catalog: DefinitionCatalog;
    readonly functions: WorkflowFunctionRegistry;
  }) {
    this.compiler = input.compiler;
    this.catalog = input.catalog;
    this.functions = input.functions;
  }

  compile(
    proposal: unknown,
    allowedDefinitionIds: readonly DefinitionId[],
  ): CompiledDynamicWorkflow {
    const compiled = this.compiler.compile(proposal, { allowedDefinitionIds });
    this.install(compiled);
    return compiled;
  }

  install(compiled: CompiledDynamicWorkflow): DynamicWorkflowSnapshot {
    const expectedId = definitionId(
      `workflow.dynamic.${compiled.identity.graphDigest.slice(0, 24)}`,
    );
    if (compiled.definition.id !== expectedId) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow ID ${compiled.definition.id} does not match graph identity ${expectedId}`,
      );
    }

    const existing = this.identities.get(compiled.definition.id);
    if (existing && !sameIdentity(existing, compiled.identity)) {
      throw new DynamicWorkflowCompileError(
        `Dynamic workflow ID collision for ${compiled.definition.id}`,
      );
    }

    this.functions.registerRuntimeMappings(runtimeMappings(compiled.mappings));
    this.catalog.registerRuntimeWorkflow(compiled.definition);
    this.identities.set(compiled.definition.id, compiled.identity);
    return snapshotOf(compiled);
  }

  restore(snapshot: PersistedDynamicWorkflowSnapshot): CompiledDynamicWorkflow {
    const proposal = requireProposal(snapshot.proposal);
    const allowedDefinitionIds = referencedDefinitionIds(proposal);
    const compiled = this.compiler.compile(proposal, { allowedDefinitionIds });
    if (!sameIdentity(snapshot.identity, compiled.identity)) {
      throw new DynamicWorkflowDriftError(snapshot.identity, compiled.identity);
    }
    this.install(compiled);
    return compiled;
  }

  identity(definitionId: DefinitionId): DynamicWorkflowIdentity | undefined {
    return this.identities.get(definitionId);
  }
}

export function snapshotOf(compiled: CompiledDynamicWorkflow): DynamicWorkflowSnapshot {
  return Object.freeze({
    proposal: compiled.proposal,
    identity: compiled.identity,
  });
}

function runtimeMappings(
  mappings: ReadonlyMap<ValueMappingRef, ValueMapping>,
): ReadonlyMap<ValueMappingRef, ValueMapping> {
  return new Map(
    [...mappings].map(([ref, mapping]) => [
      ref,
      (context: WorkflowEvaluationContext) => mapping(normalizeEvaluationContext(context)),
    ]),
  );
}

function normalizeEvaluationContext(
  context: WorkflowEvaluationContext,
): WorkflowEvaluationContext {
  return {
    ...context,
    latest: new Map(
      [...context.latest].map(([nodeId, value]) => [nodeId, publicNodeValue(nodeId, value)]),
    ),
  };
}

function publicNodeValue(nodeId: string, value: unknown): unknown {
  if (!isRecord(value) || typeof value.status !== "string") return value;
  if (value.status === "success" && Object.hasOwn(value, "value")) return value.value;
  if (value.status === "failure") {
    throw new Error(`Dynamic workflow result ${nodeId} failed and cannot be used as input`);
  }
  if (value.status === "cancelled") {
    throw new Error(`Dynamic workflow result ${nodeId} was cancelled and cannot be used as input`);
  }
  return value;
}

function requireProposal(value: unknown): DynamicWorkflowProposal {
  const validation = DynamicWorkflowProposalSchema.validate(value);
  if (!validation.ok) {
    throw new DynamicWorkflowCompileError(
      `Persisted dynamic workflow proposal is invalid: ${validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return validation.value;
}

function referencedDefinitionIds(proposal: DynamicWorkflowProposal): readonly DefinitionId[] {
  return [
    ...new Set(
      proposal.nodes.flatMap((node) =>
        node.kind === "invoke" ? [definitionId(node.definitionId)] : [],
      ),
    ),
  ];
}

function sameIdentity(
  left: PersistedDynamicWorkflowIdentity,
  right: PersistedDynamicWorkflowIdentity,
): boolean {
  return (
    left.version === right.version &&
    left.graphDigest === right.graphDigest &&
    sameRecord(left.definitionDigests, right.definitionDigests) &&
    sameRecord(left.schemaDigests, right.schemaDigests)
  );
}

function sameRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => right[key] === value)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
