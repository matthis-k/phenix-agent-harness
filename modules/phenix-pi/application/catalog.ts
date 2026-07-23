import type {
  AnyDefinition,
  Definition,
  DefinitionRef,
  PureConditionRef,
  PureDecisionRef,
  ValueMappingRef,
  WorkflowDefinition,
} from "../domain/definition/definition.ts";
import type { DefinitionId } from "../domain/shared.ts";
import type {
  PureCondition,
  PureDecision,
  ValueMapping,
  WorkflowFunctionRegistrar,
} from "../domain/workflow/functions.ts";
import {
  validateWorkflow,
  type WorkflowDiagnostic,
  type WorkflowFunctionInventory,
} from "../domain/workflow/validator.ts";
import type { LocalOperationRunner } from "../ports/local-operation-runner.ts";

export class WorkflowFunctionRegistry implements WorkflowFunctionRegistrar {
  private readonly mappings = new Map<ValueMappingRef, ValueMapping>();
  private readonly decisions = new Map<PureDecisionRef, PureDecision>();
  private readonly conditions = new Map<PureConditionRef, PureCondition>();
  private sealed = false;

  registerMapping(ref: ValueMappingRef, mapping: ValueMapping): void {
    this.assertMutable();
    if (this.mappings.has(ref)) throw new Error(`Duplicate workflow mapping: ${ref}`);
    this.mappings.set(ref, mapping);
  }

  registerDecision(ref: PureDecisionRef, decision: PureDecision): void {
    this.assertMutable();
    if (this.decisions.has(ref)) throw new Error(`Duplicate workflow decision: ${ref}`);
    this.decisions.set(ref, decision);
  }

  registerCondition(ref: PureConditionRef, condition: PureCondition): void {
    this.assertMutable();
    if (this.conditions.has(ref)) throw new Error(`Duplicate workflow condition: ${ref}`);
    this.conditions.set(ref, condition);
  }

  mapping(ref: ValueMappingRef): ValueMapping {
    const mapping = this.mappings.get(ref);
    if (!mapping) throw new Error(`Unknown workflow mapping: ${ref}`);
    return mapping;
  }

  decision(ref: PureDecisionRef): PureDecision {
    const decision = this.decisions.get(ref);
    if (!decision) throw new Error(`Unknown workflow decision: ${ref}`);
    return decision;
  }

  condition(ref: PureConditionRef): PureCondition {
    const condition = this.conditions.get(ref);
    if (!condition) throw new Error(`Unknown workflow condition: ${ref}`);
    return condition;
  }

  hasMapping(ref: ValueMappingRef): boolean {
    return this.mappings.has(ref);
  }

  hasDecision(ref: PureDecisionRef): boolean {
    return this.decisions.has(ref);
  }

  hasCondition(ref: PureConditionRef): boolean {
    return this.conditions.has(ref);
  }

  seal(): void {
    this.sealed = true;
  }

  private assertMutable(): void {
    if (this.sealed) throw new Error(`Workflow function registry is sealed`);
  }
}

export class DefinitionCatalog {
  private readonly definitions = new Map<DefinitionId, AnyDefinition>();
  private readonly diagnostics: WorkflowDiagnostic[] = [];
  private sealed = false;

  register(definition: AnyDefinition): void {
    if (this.sealed) throw new Error(`Definition catalog is sealed`);
    if (this.definitions.has(definition.id))
      throw new Error(`Duplicate definition ${definition.id}`);
    this.definitions.set(definition.id, deepFreeze(definition));
  }

  seal(functions: WorkflowFunctionRegistry, operations: LocalOperationRunner): void {
    if (this.sealed) return;
    const inventory: WorkflowFunctionInventory = {
      hasMapping: (ref) => functions.hasMapping(ref),
      hasDecision: (ref) => functions.hasDecision(ref),
      hasCondition: (ref) => functions.hasCondition(ref),
      hasOperation: (ref) => operations.has(ref),
      hasDefinition: (id) => this.definitions.has(id as DefinitionId),
    };
    for (const definition of this.definitions.values()) {
      if (definition.kind === "workflow") {
        this.diagnostics.push(
          ...validateWorkflow(definition as WorkflowDefinition<unknown, unknown>, inventory),
        );
      } else {
        this.diagnostics.push(...validateAgent(definition, inventory));
      }
    }
    this.sealed = true;
    functions.seal();
    const errors = this.diagnostics.filter((item) => item.severity === "error");
    if (errors.length > 0) {
      throw new Error(
        `Invalid Phenix catalog:\n${errors.map((item) => `[${item.code}] ${item.message}`).join("\n")}`,
      );
    }
  }

  get<I, O>(ref: DefinitionRef<I, O>): Definition<I, O> {
    return this.require(ref.id) as Definition<I, O>;
  }

  require(id: DefinitionId): AnyDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Definition not found: ${id}`);
    return definition;
  }

  list(): readonly AnyDefinition[] {
    return [...this.definitions.values()];
  }

  validateAll(): readonly WorkflowDiagnostic[] {
    return this.diagnostics;
  }
}

function validateAgent(
  definition: Extract<AnyDefinition, { readonly kind: "agent" }>,
  inventory: WorkflowFunctionInventory,
): WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const error = (code: string, message: string): void => {
    diagnostics.push({ severity: "error", code, message: `${definition.id}: ${message}` });
  };
  if (!Number.isFinite(definition.limits.timeoutMs) || definition.limits.timeoutMs < 0) {
    error("agent_timeout_invalid", `timeoutMs must be finite and non-negative`);
  }
  if (
    definition.limits.maxTurns !== undefined &&
    (!Number.isInteger(definition.limits.maxTurns) || definition.limits.maxTurns < 1)
  ) {
    error("agent_turn_limit_invalid", `maxTurns must be omitted or a positive integer`);
  }
  if (
    definition.limits.maxToolCalls !== undefined &&
    (!Number.isInteger(definition.limits.maxToolCalls) || definition.limits.maxToolCalls < 1)
  ) {
    error("agent_tool_limit_invalid", `maxToolCalls must be omitted or a positive integer`);
  }
  if (
    !Number.isInteger(definition.limits.maxRepairAttempts) ||
    definition.limits.maxRepairAttempts < 0
  ) {
    error("agent_repair_limit_invalid", `maxRepairAttempts must be a non-negative integer`);
  }
  if (!Number.isInteger(definition.context.maxBytes) || definition.context.maxBytes < 0) {
    error("agent_context_invalid", `context maxBytes must be a non-negative integer`);
  }
  if (
    !Number.isInteger(definition.childCapabilities.maxDepth) ||
    definition.childCapabilities.maxDepth < 0
  ) {
    error("agent_capability_invalid", `capability maxDepth must be a non-negative integer`);
  }
  for (const id of definition.childCapabilities.invokableDefinitions) {
    if (!inventory.hasDefinition(id)) {
      error("agent_capability_definition_missing", `unknown child capability definition ${id}`);
    }
  }
  if (new Set(definition.tools.allow).size !== definition.tools.allow.length) {
    error("agent_tool_duplicate", `tool allowlist contains duplicates`);
  }
  return diagnostics;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    deepFreeze((object as Record<PropertyKey, unknown>)[key], seen);
  }
  return Object.freeze(value);
}
