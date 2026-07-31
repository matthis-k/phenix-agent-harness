import type { Outcome } from "../../domain/shared.ts";
import type { WorkflowFunctionRegistrar } from "../../domain/workflow/functions.ts";
import type { WorkflowEvaluationContext } from "../../domain/workflow/graph-state.ts";
import type { DifficultyAssessment } from "../difficulty.ts";
import type {
  BaseResult,
  ChangeSet,
  CheckResult,
  CriticReport,
  ImplementationRequest,
  ImplementationResult,
  ObjectiveRequest,
  PlanResult,
  QAReport,
  QASynthesisRequest,
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
  registry.registerMapping(
    "qa.synthesize.input",
    (context): QASynthesisRequest => ({
      objective: (context.input as ObjectiveRequest).objective,
      checks: localAt<readonly CheckResult[]>(context, "checks"),
      reports: [
        successAt(context, "repo"),
        successAt(context, "tests"),
        successAt(context, "architecture"),
        successAt(context, "security"),
      ],
    }),
  );
  registry.registerMapping(
    "qa.output",
    (context): QAReport => ({
      ...successAt<QAReport>(context, "synthesize"),
      checks: localAt<readonly CheckResult[]>(context, "checks"),
    }),
  );

  registerDebugFunctions(registry);
  registerRefactorFunctions(registry);
  registerMigrationFunctions(registry);
  registerReviewFunctions(registry);
  registerDesignFunctions(registry);
  registerUiChangeFunctions(registry);
  registerResearchFunctions(registry);
  registerSecurityFunctions(registry);
}

function registerDebugFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("debug.reproduce.input", (context) =>
    scoutInput(
      context,
      "reproduction, runtime evidence, and the smallest reliable failing scenario",
      "Reproduce the reported behavior before proposing a repair. Distinguish a reliable reproduction from an intermittent, environment-dependent, or unreproduced symptom.",
    ),
  );
  registry.registerMapping("debug.diagnose.input", (context) =>
    criticInput(
      context,
      "causal diagnosis and competing hypotheses",
      "Determine the root cause from the reproduction evidence. Reject merely correlated observations and identify what evidence would falsify the diagnosis.",
      ["reproduce"],
    ),
  );
  registry.registerMapping("debug.implement.input", (context) =>
    implementationInput(
      context,
      "Repair the established root cause, preserve unrelated behavior, and add or update a regression check for the original scenario.",
      ["reproduce", "diagnose"],
      criticFindingsAt(context, "diagnose"),
    ),
  );
  registry.registerMapping("debug.regression.input", (context) =>
    implementationTestInput(
      context,
      "Exercise the original failing scenario and nearby regression surface after the repair. Report explicitly whether the original symptom was reproduced before and eliminated after the change.",
      "implement",
      ["reproduce", "diagnose"],
    ),
  );
  registry.registerMapping("debug.finalize.input", (context) =>
    finalizerInput(
      context,
      "debug",
      "Summarize reproduction, root cause, repair, and regression evidence. Distinguish established facts from remaining uncertainty.",
      ["reproduce", "diagnose", "implement", "regression"],
    ),
  );
  registry.registerMapping(
    "debug.output",
    (context): BaseResult => successAt<BaseResult>(context, "finalize"),
  );
}

function registerRefactorFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("refactor.characterize.input", (context) =>
    scoutInput(
      context,
      "externally visible behavior, public contracts, invariants, and existing characterization coverage",
      "Inventory behavior that must remain stable and identify missing characterization checks before structural changes begin.",
    ),
  );
  registry.registerMapping("refactor.architecture.input", (context) =>
    criticInput(
      context,
      "ownership, dependency direction, invalid states, duplication, and the smallest useful target architecture",
      "Define a simpler target structure without changing intended behavior. Prefer fewer architectural surfaces over relocating complexity behind new wrappers.",
      ["characterize"],
    ),
  );
  registry.registerMapping("refactor.implement.input", (context) =>
    implementationInput(
      context,
      "Perform a behavior-preserving refactor. Preserve the characterized contracts, reduce unnecessary surfaces, and avoid compatibility layers unless the caller explicitly requires one.",
      ["characterize", "architecture"],
      criticFindingsAt(context, "architecture"),
    ),
  );
  registry.registerMapping("refactor.review.input", (context) =>
    criticInput(
      context,
      "semantic preservation and whether the resulting architecture is materially simpler",
      "Review the completed refactor. Check that complexity was removed rather than displaced, invalid states became less representable, and public behavior remains supported by evidence.",
      ["characterize", "architecture", "implement"],
    ),
  );
  registry.registerMapping("refactor.finalize.input", (context) =>
    finalizerInput(
      context,
      "refactor",
      "Summarize preserved invariants, structural changes, verification evidence, and any remaining architectural debt.",
      ["characterize", "architecture", "implement", "review"],
    ),
  );
  registry.registerMapping(
    "refactor.output",
    (context): BaseResult => successAt<BaseResult>(context, "finalize"),
  );
}

function registerMigrationFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("migrate.inventory.input", (context) =>
    scoutInput(
      context,
      "affected contracts, providers, consumers, generated artifacts, configuration, and cleanup obligations",
      "Build a dependency-aware inventory. Identify repository or package boundaries and distinguish authoritative definitions from derived consumers.",
    ),
  );
  registry.registerMapping("migrate.plan.input", (context) => {
    const input = objectiveInput(context);
    return {
      objective: scopedObjective(
        input,
        "Produce an ordered migration plan with explicit provider/consumer sequencing, compatibility policy, cleanup steps, rollback boundaries, and verification gates.",
      ),
      context: input.context,
      evidence: successAt(context, "inventory"),
    };
  });
  registry.registerMapping("migrate.implement.input", (context) => {
    const input = objectiveInput(context);
    const plan = successAt<PlanResult>(context, "plan");
    return {
      objective: scopedObjective(
        input,
        "Execute the migration completely: update providers and consumers in dependency order, remove obsolete paths, and leave the repository graph valid. Do not retain fallback compatibility unless explicitly required by the caller.",
      ),
      context: workflowContext(context, ["inventory", "plan"]),
      plan,
    };
  });
  registry.registerMapping("migrate.audit.input", (context) =>
    criticInput(
      context,
      "migration completeness, dependency ordering, stale consumers, and legacy removal",
      "Audit the completed migration. Verify that every affected consumer moved, obsolete interfaces and adapters were removed, and the final dependency graph is coherent.",
      ["inventory", "plan", "implement"],
    ),
  );
  registry.registerMapping("migrate.finalize.input", (context) =>
    finalizerInput(
      context,
      "migration",
      "Summarize migrated contracts and consumers, execution order, verification evidence, removed legacy surfaces, and unresolved migration risks.",
      ["inventory", "plan", "implement", "audit"],
    ),
  );
  registry.registerMapping(
    "migrate.output",
    (context): BaseResult => successAt<BaseResult>(context, "finalize"),
  );
}

function registerReviewFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping(
    "review.output",
    (context): QAReport => successAt<QAReport>(context, "review"),
  );
}

function registerDesignFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("design.inspect.input", (context) =>
    scoutInput(
      context,
      "requirements, existing mechanisms, constraints, extension points, and non-goals",
      "Inspect the actual system before designing. Identify reusable mechanisms and constraints that materially limit the solution space.",
    ),
  );
  registry.registerMapping("design.alternatives.input", (context) => {
    const input = objectiveInput(context);
    return {
      objective: scopedObjective(
        input,
        "Develop materially different design alternatives, compare their trade-offs, select a preferred direction, and produce implementation slices and verification criteria.",
      ),
      context: input.context,
      evidence: successAt(context, "inspect"),
    };
  });
  registry.registerMapping("design.architecture.input", (context) =>
    criticInput(
      context,
      "ownership, interfaces, data flow, state model, failure handling, and replacement seams",
      "Evaluate the proposed alternatives against the existing system. Make interface and ownership decisions explicit and identify how failures remain localized.",
      ["inspect", "alternatives"],
    ),
  );
  registry.registerMapping("design.critique.input", (context) =>
    criticInput(
      context,
      "assumptions, rejected alternatives, operational failure modes, and implementation risk",
      "Challenge the proposed design rather than restating it. Identify unsupported assumptions, hidden coupling, invalid states, and the conditions under which another alternative would be preferable.",
      ["inspect", "alternatives", "architecture"],
    ),
  );
  registry.registerMapping("design.finalize.input", (context) =>
    finalizerInput(
      context,
      "design",
      "Produce a decision-oriented design containing the selected direction, invariants, interfaces, ownership, data flow, failure handling, rejected alternatives, implementation slices, and verification strategy.",
      ["inspect", "alternatives", "architecture", "critique"],
    ),
  );
  registry.registerMapping(
    "design.output",
    (context): BaseResult => successAt<BaseResult>(context, "finalize"),
  );
}

function registerUiChangeFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("ui-change.inspect.input", (context) =>
    scoutInput(
      context,
      "interaction paths, rendering ownership, state transitions, focus, input, scrolling, sizing, asynchronous updates, and available UI test facilities",
      "Inspect the framework-native UI architecture and current behavior before proposing changes. Identify the interaction states that can fail independently.",
    ),
  );
  registry.registerMapping("ui-change.design.input", (context) =>
    criticInput(
      context,
      "layout, focus, selection, input routing, scrolling, update ordering, loading, empty, and error-state invariants",
      "Specify framework-independent interaction invariants and map them onto the framework's native state and rendering model. Prefer designs that localize state and stale-update failures.",
      ["inspect"],
    ),
  );
  registry.registerMapping("ui-change.implement.input", (context) =>
    implementationInput(
      context,
      "Implement the UI behavior using framework-native mechanisms. Preserve explicit interaction invariants across resize, focus changes, asynchronous updates, loading, empty, and error states, and add the strongest practical scenario coverage.",
      ["inspect", "design"],
      criticFindingsAt(context, "design"),
    ),
  );
  registry.registerMapping("ui-change.scenarios.input", (context) =>
    implementationTestInput(
      context,
      "Exercise a framework-appropriate scenario matrix covering focus, selection visibility, keyboard and pointer input where supported, scrolling, resize, asynchronous refresh, and loading, empty, recoverable-error, and terminal-error states.",
      "implement",
      ["inspect", "design"],
    ),
  );
  registry.registerMapping("ui-change.critique.input", (context) =>
    criticInput(
      context,
      "interaction quality, consistency, accessibility, state ownership, stale updates, and evidence gaps",
      "Review the completed UI change and scenario evidence. Report behavior that remains ambiguous, framework-hostile, visually unstable, or insufficiently exercised.",
      ["inspect", "design", "implement", "scenarios"],
    ),
  );
  registry.registerMapping("ui-change.finalize.input", (context) =>
    finalizerInput(
      context,
      "ui-change",
      "Summarize interaction invariants, implementation, scenario evidence, usability review, and remaining framework-specific limitations.",
      ["inspect", "design", "implement", "scenarios", "critique"],
    ),
  );
  registry.registerMapping(
    "ui-change.output",
    (context): BaseResult => successAt<BaseResult>(context, "finalize"),
  );
}

function registerResearchFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("research.repository.input", (context) =>
    scoutInput(
      context,
      "repository code, local behavior, tests, history available in the workspace, and implementation constraints",
      "Gather direct local evidence relevant to the research question. Do not mutate the repository.",
    ),
  );
  registry.registerMapping("research.ecosystem.input", (context) =>
    scoutInput(
      context,
      "upstream documentation, framework capabilities, prior art, and external compatibility constraints available through authorized tools",
      "Gather ecosystem evidence and distinguish documented behavior from inference. Do not mutate the repository.",
    ),
  );
  registry.registerMapping("research.constraints.input", (context) =>
    scoutInput(
      context,
      "counterexamples, performance or operational constraints, failure modes, and evidence that could invalidate the obvious recommendation",
      "Actively seek disconfirming evidence and unresolved constraints. Do not mutate the repository.",
    ),
  );
  registry.registerMapping("research.challenge.input", (context) =>
    criticInput(
      context,
      "contradictions, source quality, unsupported inference, confidence, and decision consequences",
      "Reconcile the independent investigations. Challenge unsupported claims and identify which conclusions are established, inferred, disputed, or unresolved.",
      ["repository", "ecosystem", "constraints"],
    ),
  );
  registry.registerMapping("research.finalize.input", (context) =>
    finalizerInput(
      context,
      "research",
      "Produce a concise recommendation with supporting evidence, confidence, alternatives, contradictions, and unresolved questions. Keep facts and inferences distinct.",
      ["repository", "ecosystem", "constraints", "challenge"],
    ),
  );
  registry.registerMapping(
    "research.output",
    (context): BaseResult => successAt<BaseResult>(context, "finalize"),
  );
}

function registerSecurityFunctions(registry: WorkflowFunctionRegistrar): void {
  registry.registerMapping("security.surface.input", (context) =>
    scoutInput(
      context,
      "entry points, sensitive assets, privilege boundaries, untrusted inputs, secret handling, command execution, persistence, and external interfaces",
      "Map the concrete security surface and trust assumptions from repository evidence. Remain read-only.",
    ),
  );
  registry.registerMapping("security.threat-model.input", (context) =>
    criticInput(
      context,
      "assets, actors, trust boundaries, privilege transitions, attack paths, and containment boundaries",
      "Build a repository-grounded threat model. Prioritize plausible paths by impact and required preconditions rather than enumerating generic vulnerability classes.",
      ["surface"],
    ),
  );
  registry.registerMapping("security.adversarial.input", (context) =>
    criticInput(
      context,
      "validation of concrete exploit paths, authorization failures, unsafe data flow, and mitigation strength",
      "Adversarially validate the threat model using safe, targeted, read-only checks where needed. Do not modify the repository or perform destructive exploitation. Reject findings without a concrete path or supporting evidence.",
      ["surface", "threat-model"],
    ),
  );
  registry.registerMapping("security.finalize.input", (context) =>
    finalizerInput(
      context,
      "security",
      "Summarize assets, trust boundaries, validated risks, severity and preconditions, evidence, recommended mitigations, and unresolved uncertainty. Do not claim a fix was applied.",
      ["surface", "threat-model", "adversarial"],
    ),
  );
  registry.registerMapping(
    "security.output",
    (context): BaseResult => successAt<BaseResult>(context, "finalize"),
  );
}

function difficultyAt(context: WorkflowEvaluationContext) {
  return successAt<DifficultyAssessment>(context, "estimate").difficulty;
}

function objectiveInput(context: WorkflowEvaluationContext): ObjectiveRequest {
  return context.input as ObjectiveRequest;
}

function scopedObjective(input: ObjectiveRequest, instruction: string): string {
  return `${instruction}\n\nCaller objective: ${input.objective}`;
}

function scoutInput(context: WorkflowEvaluationContext, focus: string, instruction: string) {
  const input = objectiveInput(context);
  return {
    objective: scopedObjective(input, instruction),
    context: input.context,
    focus,
  };
}

function criticInput(
  context: WorkflowEvaluationContext,
  focus: string,
  instruction: string,
  artifactNodes: readonly string[],
) {
  const input = objectiveInput(context);
  return {
    objective: scopedObjective(input, instruction),
    context: input.context,
    artifact: successfulArtifacts(context, artifactNodes),
    focus,
  };
}

function implementationInput(
  context: WorkflowEvaluationContext,
  instruction: string,
  artifactNodes: readonly string[],
  findings: readonly string[] = [],
): ImplementationRequest {
  const input = objectiveInput(context);
  return {
    objective: scopedObjective(input, instruction),
    context: workflowContext(context, artifactNodes),
    ...(findings.length === 0 ? {} : { findings }),
  };
}

function implementationTestInput(
  context: WorkflowEvaluationContext,
  instruction: string,
  implementationNode: string,
  artifactNodes: readonly string[],
) {
  const input = objectiveInput(context);
  const implementation = successAt<ImplementationResult>(context, implementationNode);
  return {
    objective: scopedObjective(input, instruction),
    context: {
      callerContext: input.context,
      completed: successfulArtifacts(context, artifactNodes),
      implementation,
    },
    checks: implementation.changeSet.checks,
  };
}

function finalizerInput(
  context: WorkflowEvaluationContext,
  workflow: string,
  instruction: string,
  artifactNodes: readonly string[],
): ObjectiveRequest {
  const input = objectiveInput(context);
  return {
    objective: scopedObjective(
      input,
      `${instruction} This is the final handoff for workflow.${workflow}.`,
    ),
    context: workflowContext(context, artifactNodes),
  };
}

function workflowContext(
  context: WorkflowEvaluationContext,
  artifactNodes: readonly string[],
): unknown {
  const input = objectiveInput(context);
  return {
    callerContext: input.context,
    completed: successfulArtifacts(context, artifactNodes),
  };
}

function successfulArtifacts(
  context: WorkflowEvaluationContext,
  nodes: readonly string[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(nodes.map((node) => [node, successAt(context, node)]));
}

function criticFindingsAt(context: WorkflowEvaluationContext, node: string): readonly string[] {
  return successAt<CriticReport>(context, node).findings.map(
    (finding) => `${finding.title}: ${finding.evidence}`,
  );
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
