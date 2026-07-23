import type { AnyDefinition, WorkflowDefinition } from "../domain/definition/definition.ts";
import { assessExecutionRisk } from "../domain/definition/execution-risk.ts";
import { DEFAULT_SESSION_PROFILE, type RunRecord } from "../domain/run/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { DefinitionCatalog } from "./catalog.ts";
import type { ExecutionStore } from "./execution-store.ts";

export interface InvocationPolicyContext {
  readonly rootRunId: RunId;
  readonly parent: RunRecord;
  readonly definition: AnyDefinition;
  readonly input: unknown;
}

export interface InvocationPolicy {
  assertAllowed(context: InvocationPolicyContext): void;
}

export const allowAllInvocations: InvocationPolicy = {
  assertAllowed() {},
};

export class SessionInvocationPolicy implements InvocationPolicy {
  private readonly store: ExecutionStore;
  private readonly catalog: DefinitionCatalog;

  constructor(input: { readonly store: ExecutionStore; readonly catalog: DefinitionCatalog }) {
    this.store = input.store;
    this.catalog = input.catalog;
  }

  assertAllowed(context: InvocationPolicyContext): void {
    const profile =
      this.store.projection.requireRun(context.rootRunId).profile ?? DEFAULT_SESSION_PROFILE;
    if (profile.modelSet !== "free" || !this.mayMutate(context.definition, new Set())) return;

    const assessment = assessExecutionRisk(context.input);
    if (!assessment.sensitive) return;
    throw new Error(
      `phenix/free may not execute sensitive mutation through ${context.definition.id}: ${assessment.reasons.join("; ")}. Select phenix/opencode-go, phenix/chatgpt-plus, or phenix/mixed.`,
    );
  }

  private mayMutate(definition: AnyDefinition, visited: Set<string>): boolean {
    if (visited.has(definition.id)) return false;
    visited.add(definition.id);
    if (definition.kind === "agent") {
      return definition.tools.allow.includes("edit") || definition.tools.allow.includes("write");
    }

    return (definition as WorkflowDefinition<unknown, unknown>).graph.nodes.some((node) => {
      if (node.kind !== "invoke") return false;
      return this.mayMutate(this.catalog.require(node.definition.id), visited);
    });
  }
}
