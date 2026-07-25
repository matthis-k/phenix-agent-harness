import {
  type CompiledDynamicWorkflow,
  DynamicWorkflowCompileError,
  DynamicWorkflowCompiler,
  type DynamicWorkflowIdentity,
} from "./dynamic-workflow-compiler.ts";
import type { DynamicWorkflowProposal } from "../definitions/dynamic-workflow.ts";
import { definitionId, type DefinitionId } from "../domain/shared.ts";
import { DefinitionCatalog, WorkflowFunctionRegistry } from "./catalog.ts";

export interface DynamicWorkflowSnapshot {
  readonly proposal: DynamicWorkflowProposal;
  readonly identity: DynamicWorkflowIdentity;
}

export class DynamicWorkflowDriftError extends Error {
  readonly expected: DynamicWorkflowIdentity;
  readonly actual: DynamicWorkflowIdentity;

  constructor(expected: DynamicWorkflowIdentity, actual: DynamicWorkflowIdentity) {
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

    this.functions.registerRuntimeMappings(compiled.mappings);
    this.catalog.registerRuntimeWorkflow(compiled.definition);
    this.identities.set(compiled.definition.id, compiled.identity);
    return snapshotOf(compiled);
  }

  restore(snapshot: DynamicWorkflowSnapshot): CompiledDynamicWorkflow {
    const allowedDefinitionIds = referencedDefinitionIds(snapshot.proposal);
    const compiled = this.compiler.compile(snapshot.proposal, { allowedDefinitionIds });
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
  left: DynamicWorkflowIdentity,
  right: DynamicWorkflowIdentity,
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
