import { definitionRef, type WorkflowDefinition } from "../../domain/definition/definition.ts";
import {
  AGENT_BASE,
  AGENT_CRITIC,
  AGENT_IMPLEMENTER,
  AGENT_PLANNER,
  AGENT_QA_SYNTHESIZER,
  AGENT_SCOUT,
  AGENT_VERIFIER,
  WORKFLOW_DIRECT,
  WORKFLOW_DYNAMIC,
  WORKFLOW_IMPLEMENT,
  WORKFLOW_QA,
  WORKFLOW_QA_FIX,
} from "../ids.ts";
import {
  BaseResultSchema,
  FinalReportSchema,
  ImplementationRequestSchema,
  ImplementationResultSchema,
  ObjectiveRequestSchema,
  QAReportSchema,
} from "../schemas.ts";

export const directWorkflow: WorkflowDefinition<unknown, unknown> = {
  id: WORKFLOW_DIRECT,
  kind: "workflow",
  title: "Direct agent workflow",
  description: "Invoke the bounded base agent and return its typed output.",
  input: ObjectiveRequestSchema,
  output: BaseResultSchema,
  limits: { timeoutMs: 1_200_000, maxNodeRuns: 4, maxParallelism: 1 },
  graph: {
    entry: "base",
    nodes: [
      {
        kind: "invoke",
        id: "base",
        definition: definitionRef(AGENT_BASE),
        input: "direct.base.input",
        wait: "await",
      },
      { kind: "return", id: "return", output: "direct.output" },
    ],
    edges: [{ from: "base", to: "return" }],
  },
};

export const implementationWorkflow: WorkflowDefinition<unknown, unknown> = {
  id: WORKFLOW_IMPLEMENT,
  kind: "workflow",
  title: "Implementation workflow",
  description: "Plan, implement, independently verify, and perform at most two repair attempts.",
  input: ImplementationRequestSchema,
  output: ImplementationResultSchema,
  limits: { timeoutMs: 2_400_000, maxNodeRuns: 20, maxParallelism: 1 },
  graph: {
    entry: "plan",
    nodes: [
      {
        kind: "invoke",
        id: "plan",
        title: "Produce an executable plan",
        definition: definitionRef(AGENT_PLANNER),
        input: "implement.plan.input",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "implement",
        title: "Apply the current implementation attempt",
        definition: definitionRef(AGENT_IMPLEMENTER),
        input: "implement.work.input",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "verify",
        title: "Independently verify the attempt",
        definition: definitionRef(AGENT_VERIFIER),
        input: "implement.verify.input",
        wait: "await",
      },
      { kind: "decision", id: "accepted", decide: "implement.acceptance" },
      { kind: "return", id: "return", output: "implement.output" },
      { kind: "fail", id: "fail", reason: "implement.failure" },
    ],
    edges: [
      { from: "plan", to: "implement" },
      { from: "implement", to: "verify", maxTraversals: 3 },
      { from: "verify", to: "accepted", maxTraversals: 3 },
      { from: "accepted", to: "return", when: "decision.accepted" },
      {
        from: "accepted",
        to: "implement",
        when: "decision.repair",
        maxTraversals: 2,
      },
      { from: "accepted", to: "fail", when: "decision.exhausted" },
    ],
  },
};

export const qaWorkflow: WorkflowDefinition<unknown, unknown> = {
  id: WORKFLOW_QA,
  kind: "workflow",
  title: "QA workflow",
  description:
    "Fan out independent repository, test, architecture, and security reviews, then synthesize.",
  input: ObjectiveRequestSchema,
  output: QAReportSchema,
  limits: { timeoutMs: 1_800_000, maxNodeRuns: 16, maxParallelism: 4 },
  graph: {
    entry: "fanout",
    nodes: [
      {
        kind: "local",
        id: "fanout",
        title: "Start independent QA branches",
        operation: "local.noop",
        input: "input.identity",
      },
      {
        kind: "invoke",
        id: "repo",
        definition: definitionRef(AGENT_SCOUT),
        input: "qa.repo.input",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "tests",
        definition: definitionRef(AGENT_SCOUT),
        input: "qa.tests.input",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "architecture",
        definition: definitionRef(AGENT_CRITIC),
        input: "qa.arch.input",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "security",
        definition: definitionRef(AGENT_CRITIC),
        input: "qa.security.input",
        wait: "await",
      },
      { kind: "join", id: "join", policy: "all-success" },
      {
        kind: "invoke",
        id: "synthesize",
        definition: definitionRef(AGENT_QA_SYNTHESIZER),
        input: "qa.synthesize.input",
        wait: "await",
      },
      { kind: "return", id: "return", output: "qa.output" },
    ],
    edges: [
      { from: "fanout", to: "repo" },
      { from: "fanout", to: "tests" },
      { from: "fanout", to: "architecture" },
      { from: "fanout", to: "security" },
      { from: "repo", to: "join" },
      { from: "tests", to: "join" },
      { from: "architecture", to: "join" },
      { from: "security", to: "join" },
      { from: "join", to: "synthesize" },
      { from: "synthesize", to: "return" },
    ],
  },
};

export const qaAndFixWorkflow: WorkflowDefinition<unknown, unknown> = {
  id: WORKFLOW_QA_FIX,
  kind: "workflow",
  title: "QA and fix workflow",
  description:
    "Run QA, invoke the implementation workflow for actionable findings, and verify once more.",
  input: ObjectiveRequestSchema,
  output: FinalReportSchema,
  limits: { timeoutMs: 4_200_000, maxNodeRuns: 12, maxParallelism: 1 },
  graph: {
    entry: "qa",
    nodes: [
      {
        kind: "invoke",
        id: "qa",
        definition: definitionRef(WORKFLOW_QA),
        input: "qa-fix.qa.input",
        wait: "await",
      },
      { kind: "decision", id: "actionable", decide: "qa-fix.actionable" },
      {
        kind: "invoke",
        id: "fix",
        definition: definitionRef(WORKFLOW_IMPLEMENT),
        input: "qa-fix.implement.input",
        wait: "await",
      },
      {
        kind: "invoke",
        id: "final",
        definition: definitionRef(AGENT_VERIFIER),
        input: "qa-fix.verify.input",
        wait: "await",
      },
      { kind: "return", id: "return", output: "qa-fix.output" },
      { kind: "return", id: "noop", output: "qa-fix.noop.output" },
    ],
    edges: [
      { from: "qa", to: "actionable" },
      { from: "actionable", to: "fix", when: "decision.fix" },
      { from: "actionable", to: "noop", when: "decision.noop" },
      { from: "fix", to: "final" },
      { from: "final", to: "return" },
    ],
  },
};

export const dynamicWorkflow: WorkflowDefinition<unknown, unknown> = {
  id: WORKFLOW_DYNAMIC,
  kind: "workflow",
  title: "Dynamic workflow",
  description:
    "Run a bounded coordinator agent that may invoke only its allowed typed catalog entries.",
  input: ObjectiveRequestSchema,
  output: BaseResultSchema,
  limits: { timeoutMs: 2_400_000, maxNodeRuns: 4, maxParallelism: 1 },
  graph: {
    entry: "coordinator",
    nodes: [
      {
        kind: "invoke",
        id: "coordinator",
        definition: definitionRef(AGENT_BASE),
        input: "dynamic.coordinator.input",
        wait: "await",
      },
      { kind: "return", id: "return", output: "dynamic.output" },
    ],
    edges: [{ from: "coordinator", to: "return" }],
  },
};

export const workflowDefinitions = [
  directWorkflow,
  implementationWorkflow,
  qaWorkflow,
  qaAndFixWorkflow,
  dynamicWorkflow,
] as const;
