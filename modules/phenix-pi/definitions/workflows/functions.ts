import type { Outcome } from "../../domain/shared.ts";
import type { WorkflowFunctionRegistrar } from "../../domain/workflow/functions.ts";
import type { WorkflowEvaluationContext } from "../../domain/workflow/graph-state.ts";
import type {
  ChangeSet,
  CheckResult,
  ImplementationRequest,
  ImplementationResult,
  ObjectiveRequest,
  VerificationResult,
} from "../schemas.ts";

export function registerWorkflowFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("input.identity", (context) => context.input);

  registry.registerMapping("implement.plan.input", (context) => {
    const input = context.input as ImplementationRequest;
    return { objective: input.objective, context: input.context };
  });
  registry.registerMapping("implement.work.input", (context) => {
    const input = context.input as ImplementationRequest;
    const previous = valuesAt<ChangeSet>(context, "implement");
    const verification = valuesAt<VerificationResult>(context, "verify").at(-1);
    return {
      objective: input.objective,
      context: input.context,
      plan: successAt(context, "plan"),
      ...(input.findings ? { findings: input.findings } : {}),
      ...(previous.length > 0 ? { previousChangeSet: previous.at(-1) } : {}),
      ...(verification && !verification.accepted ? { findings: verification.findings } : {}),
    };
  });
  registry.registerMapping("implement.verify.input", (context) => {
    const input = context.input as ImplementationRequest;
    return {
      objective: input.objective,
      context: input.context,
      changeSet: successAt(context, "implement"),
    };
  });
  registry.registerDecision("implement.acceptance", (context) => {
    const verification = successAt<VerificationResult>(context, "verify");
    if (verification.accepted) return "accepted";
    const attempts = valuesAt(context, "implement").length;
    return attempts < 3 ? "repair" : "exhausted";
  });
  registry.registerCondition("decision.accepted", (_context, decision) => decision === "accepted");
  registry.registerCondition("decision.repair", (_context, decision) => decision === "repair");
  registry.registerCondition(
    "decision.exhausted",
    (_context, decision) => decision === "exhausted",
  );
  registry.registerMapping("implement.output", (context): ImplementationResult => {
    const verification = successAt<VerificationResult>(context, "verify");
    const changeSet = successAt<ChangeSet>(context, "implement");
    return {
      summary: verification.summary,
      changeSet,
      verification,
      attempts: valuesAt(context, "implement").length,
    };
  });
  registry.registerMapping("implement.failure", (context) => {
    const verification = successAt<VerificationResult>(context, "verify");
    return `Implementation was rejected after ${valuesAt(context, "implement").length} attempts: ${verification.findings.join("; ")}`;
  });

  registry.registerMapping("qa.checks.input", (context) => {
    const input = context.input as ObjectiveRequest;
    const configured = extractConfiguredChecks(input.context);
    return configured.length > 0 ? { checks: configured } : {};
  });
  registry.registerMapping("qa.repo.input", (context) =>
    objectiveWithFocus(context, "repository structure, correctness, and maintainability"),
  );
  registry.registerMapping("qa.tests.input", (context) => {
    const input = context.input as ObjectiveRequest;
    return {
      objective: input.objective,
      context: input.context,
      checks: localAt<readonly CheckResult[]>(context, "checks"),
    };
  });
  registry.registerMapping("qa.arch.input", (context) =>
    objectiveWithFocus(
      context,
      "architecture, ownership, dependency direction, and replaceability",
    ),
  );
  registry.registerMapping("qa.security.input", (context) =>
    objectiveWithFocus(
      context,
      "security, trust boundaries, secrets, authentication, and unsafe behavior",
    ),
  );
  registry.registerMapping("qa.synthesize.input", (context) => ({
    objective: (context.input as ObjectiveRequest).objective,
    reports: [
      localAt(context, "checks"),
      successAt(context, "repo"),
      successAt(context, "tests"),
      successAt(context, "architecture"),
      successAt(context, "security"),
    ],
  }));
  registry.registerMapping("qa.output", (context) => successAt(context, "synthesize"));
}

function outcomeValue<T>(value: unknown): T {
  const outcome = value as Outcome<T>;
  if (outcome?.status !== "success") {
    throw new Error(`Workflow mapping expected a successful child outcome`);
  }
  return outcome.value;
}

function successAt<T = unknown>(context: WorkflowEvaluationContext, node: string): T {
  const value = context.latest.get(node);
  return outcomeValue<T>(value);
}

function localAt<T = unknown>(context: WorkflowEvaluationContext, node: string): T {
  if (!context.latest.has(node)) throw new Error(`Workflow mapping expected local result ${node}`);
  return context.latest.get(node) as T;
}

function valuesAt<T = unknown>(context: WorkflowEvaluationContext, node: string): readonly T[] {
  return (context.results.get(node) ?? []).map((value) => outcomeValue<T>(value));
}

function objectiveWithFocus(context: WorkflowEvaluationContext, focus: string) {
  const input = context.input as ObjectiveRequest;
  return { objective: input.objective, context: input.context, focus };
}

function extractConfiguredChecks(context: unknown): readonly unknown[] {
  if (typeof context !== "object" || context === null) return [];
  const checks = (context as { readonly checks?: unknown }).checks;
  if (!Array.isArray(checks)) return [];
  return checks;
}
