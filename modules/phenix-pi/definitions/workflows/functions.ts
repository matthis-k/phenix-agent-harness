import type { Outcome } from "../../domain/shared.ts";
import type { WorkflowFunctionRegistrar } from "../../domain/workflow/functions.ts";
import type { WorkflowEvaluationContext } from "../../domain/workflow/graph-state.ts";
import type {
  ChangeSet,
  ImplementationRequest,
  ImplementationResult,
  ObjectiveRequest,
  QAReport,
  VerificationResult,
} from "../schemas.ts";

export function registerWorkflowFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("input.identity", (context) => context.input);

  registry.registerMapping("direct.base.input", (context) => context.input);
  registry.registerMapping("direct.output", (context) => successAt(context, "base"));

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

  registry.registerMapping("qa.repo.input", (context) =>
    scopedObjective(context, "repository structure and correctness"),
  );
  registry.registerMapping("qa.tests.input", (context) =>
    scopedObjective(context, "test coverage and failing checks"),
  );
  registry.registerMapping("qa.arch.input", (context) =>
    criticObjective(context, "architecture and boundaries"),
  );
  registry.registerMapping("qa.security.input", (context) =>
    criticObjective(context, "security, trust boundaries, and unsafe behavior"),
  );
  registry.registerMapping("qa.synthesize.input", (context) => ({
    objective: (context.input as ObjectiveRequest).objective,
    reports: ["repo", "tests", "architecture", "security"].map((node) => successAt(context, node)),
  }));
  registry.registerMapping("qa.output", (context) => successAt(context, "synthesize"));

  registry.registerMapping("qa-fix.qa.input", (context) => context.input);
  registry.registerDecision("qa-fix.actionable", (context) => {
    const qa = successAt<QAReport>(context, "qa");
    return qa.findings.length > 0 ? "fix" : "noop";
  });
  registry.registerCondition("decision.fix", (_context, decision) => decision === "fix");
  registry.registerCondition("decision.noop", (_context, decision) => decision === "noop");
  registry.registerMapping("qa-fix.implement.input", (context) => {
    const input = context.input as ObjectiveRequest;
    const qa = successAt<QAReport>(context, "qa");
    return {
      objective: input.objective,
      context: input.context,
      findings: qa.findings.map((finding) => `${finding.title}: ${finding.recommendation}`),
    };
  });
  registry.registerMapping("qa-fix.verify.input", (context) => {
    const input = context.input as ObjectiveRequest;
    const implementation = successAt<ImplementationResult>(context, "fix");
    return {
      objective: input.objective,
      context: input.context,
      changeSet: implementation.changeSet,
    };
  });
  registry.registerMapping("qa-fix.output", (context) => {
    const qa = successAt<QAReport>(context, "qa");
    const implementation = successAt<ImplementationResult>(context, "fix");
    const verification = successAt<VerificationResult>(context, "final");
    return {
      summary: verification.summary,
      changed: true,
      qa,
      implementation,
      verification,
    };
  });
  registry.registerMapping("qa-fix.noop.output", (context) => {
    const qa = successAt<QAReport>(context, "qa");
    return { summary: "QA found no actionable changes.", changed: false, qa };
  });

  registry.registerMapping("dynamic.coordinator.input", (context) => context.input);
  registry.registerMapping("dynamic.output", (context) => successAt(context, "coordinator"));
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

function valuesAt<T = unknown>(context: WorkflowEvaluationContext, node: string): readonly T[] {
  return (context.results.get(node) ?? []).map((value) => outcomeValue<T>(value));
}

function scopedObjective(context: WorkflowEvaluationContext, focus: string) {
  const input = context.input as ObjectiveRequest;
  return { objective: input.objective, context: input.context, focus };
}

function criticObjective(context: WorkflowEvaluationContext, focus: string) {
  const input = context.input as ObjectiveRequest;
  return { objective: input.objective, context: input.context, focus };
}
