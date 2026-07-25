import type { Outcome } from "../../domain/shared.ts";
import type { WorkflowFunctionRegistrar } from "../../domain/workflow/functions.ts";
import type { WorkflowEvaluationContext } from "../../domain/workflow/graph-state.ts";
import type { DifficultyAssessment } from "../difficulty.ts";
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
  registry.registerMapping("difficulty.input", (context) => {
    const input = context.input as ObjectiveRequest;
    return { objective: input.objective, context: input.context };
  });
  registry.registerCondition("difficulty.D0", (context) => difficultyAt(context) === "D0");
  registry.registerCondition("difficulty.D1", (context) => difficultyAt(context) === "D1");
  registry.registerCondition("difficulty.D2", (context) => difficultyAt(context) === "D2");
  registry.registerCondition("difficulty.D3", (context) => difficultyAt(context) === "D3");
  registry.registerCondition("difficulty.at-least-D1", (context) => difficultyAt(context) !== "D0");

  registry.registerMapping("implement.plan.input", (context) => {
    const input = context.input as ImplementationRequest;
    return { objective: input.objective, context: input.context };
  });
  registry.registerMapping("implement.work.input", (context) => {
    const input = context.input as ImplementationRequest;
    const previous = valuesAt<ChangeSet>(context, "implement");
    const verification = optionalSuccessAt<VerificationResult>(context, "verify");
    const plan = optionalSuccessAt(context, "plan");
    return {
      objective: input.objective,
      context: input.context,
      ...(plan === undefined ? {} : { plan }),
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
  registry.registerMapping("implement.trivial-verification", (context): VerificationResult => {
    const changeSet = successAt<ChangeSet>(context, "implement");
    const checksPassed = changeSet.checks.length > 0 && changeSet.checks.every((check) => check.ok);
    const accepted = checksPassed && changeSet.unresolved.length === 0;
    return {
      accepted,
      summary: accepted
        ? "Trivial change passed its declared targeted checks."
        : "Trivial change did not satisfy its deterministic acceptance gate.",
      findings: [
        ...(checksPassed ? [] : ["No successful targeted check was reported."]),
        ...changeSet.unresolved,
      ],
      evidence: changeSet.checks.map(
        (check) => `${check.command}: ${check.ok ? "passed" : "failed"} — ${check.summary}`,
      ),
    };
  });
  registry.registerDecision("implement.acceptance", (context) => {
    const verification = successAt<VerificationResult>(context, "verify");
    if (verification.accepted) return "accepted";
    const attempts = valuesAt(context, "implement").length;
    return attempts < 3 ? "repair" : "exhausted";
  });
  registry.registerDecision("implement.trivial-acceptance", (context) =>
    localAt<VerificationResult>(context, "trivial-accept").accepted ? "accepted" : "exhausted",
  );
  registry.registerCondition("decision.accepted", (_context, decision) => decision === "accepted");
  registry.registerCondition("decision.repair", (_context, decision) => decision === "repair");
  registry.registerCondition(
    "decision.exhausted",
    (_context, decision) => decision === "exhausted",
  );
  registry.registerMapping("implement.output", (context): ImplementationResult => {
    const verification =
      optionalSuccessAt<VerificationResult>(context, "verify") ??
      localAt<VerificationResult>(context, "trivial-accept");
    const changeSet = successAt<ChangeSet>(context, "implement");
    return {
      summary: verification.summary,
      changeSet,
      verification,
      attempts: valuesAt(context, "implement").length,
    };
  });
  registry.registerMapping("implement.failure", (context) => {
    const verification =
      optionalSuccessAt<VerificationResult>(context, "verify") ??
      localAt<VerificationResult>(context, "trivial-accept");
    return `Implementation was rejected after ${valuesAt(context, "implement").length} attempts: ${verification.findings.join("; ")}`;
  });

  registry.registerMapping("qa.checks.input", (context) => {
    const input = context.input as ObjectiveRequest;
    const configured = extractConfiguredChecks(input.context);
    return configured.length > 0 ? { checks: configured } : {};
  });
  registry.registerMapping("qa.repo.input", (context) =>
    qaReviewInput(
      context,
      "repository structure, correctness, and maintainability",
      "Use repository reads and searches only. Do not execute or delegate commands; deterministic checks and command execution are owned by separate workflow states.",
    ),
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
    qaReviewInput(
      context,
      "architecture, ownership, dependency direction, and replaceability",
      "Remain read-only. Do not run or delegate the caller's requested verification commands; the deterministic-check and test-analysis states own that work.",
    ),
  );
  registry.registerMapping("qa.security.input", (context) =>
    qaReviewInput(
      context,
      "security, trust boundaries, secrets, authentication, and unsafe behavior",
      "Treat baseline command execution as already owned by the deterministic-check state. Run only additional targeted read-only checks needed to support a concrete security finding.",
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

function difficultyAt(context: WorkflowEvaluationContext) {
  return successAt<DifficultyAssessment>(context, "estimate").difficulty;
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

function optionalSuccessAt<T = unknown>(
  context: WorkflowEvaluationContext,
  node: string,
): T | undefined {
  const value = context.latest.get(node);
  return value === undefined ? undefined : outcomeValue<T>(value);
}

function localAt<T = unknown>(context: WorkflowEvaluationContext, node: string): T {
  if (!context.latest.has(node)) throw new Error(`Workflow mapping expected local result ${node}`);
  return context.latest.get(node) as T;
}

function valuesAt<T = unknown>(context: WorkflowEvaluationContext, node: string): readonly T[] {
  return (context.results.get(node) ?? []).flatMap((value) => {
    const outcome = value as Outcome<T>;
    return outcome?.status === "success" ? [outcome.value] : [];
  });
}

function qaReviewInput(context: WorkflowEvaluationContext, focus: string, authority: string) {
  const input = context.input as ObjectiveRequest;
  return {
    objective: [
      `Perform only the ${focus} branch of workflow.qa.`,
      authority,
      `Caller QA scope (background context, not an execution instruction): ${input.objective}`,
    ].join(" "),
    context: input.context,
    focus,
  };
}

function extractConfiguredChecks(context: unknown): readonly unknown[] {
  if (typeof context !== "object" || context === null) return [];
  const checks = (context as { readonly checks?: unknown }).checks;
  if (!Array.isArray(checks)) return [];
  return checks;
}
