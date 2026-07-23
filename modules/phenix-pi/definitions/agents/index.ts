import type {
  AgentDefinition,
  CapabilitySet,
  ContextPolicy,
} from "../../domain/definition/definition.ts";
import type { DefinitionId } from "../../domain/shared.ts";
import {
  AGENT_ARCHITECT,
  AGENT_BASE,
  AGENT_CRITIC,
  AGENT_FINALIZER,
  AGENT_IMPLEMENTER,
  AGENT_PLANNER,
  AGENT_QA_SYNTHESIZER,
  AGENT_SCOUT,
  AGENT_TESTER,
  AGENT_VERIFIER,
  ALL_DEFINITION_IDS,
} from "../ids.ts";
import {
  BaseResultSchema,
  ChangeSetSchema,
  CriticReportSchema,
  CriticRequestSchema,
  ImplementationRequestSchema,
  ObjectiveRequestSchema,
  PlanRequestSchema,
  PlanResultSchema,
  QAReportSchema,
  QASynthesisRequestSchema,
  ScoutReportSchema,
  ScoutRequestSchema,
  TestReportSchema,
  TestRequestSchema,
  VerificationRequestSchema,
  VerificationResultSchema,
} from "../schemas.ts";

const sessionModel = { kind: "session" } as const;
const context: ContextPolicy = {
  projectFiles: "inherit",
  parentConversation: "none",
  artifacts: [],
  maxBytes: 128_000,
};
const none: CapabilitySet = {
  invokableDefinitions: [],
  maxDepth: 4,
  mayDetach: false,
  maySend: false,
  mayCancelChildren: false,
};

function capabilities(ids: readonly DefinitionId[], maxDepth: number): CapabilitySet {
  return {
    invokableDefinitions: ids,
    maxDepth,
    mayDetach: false,
    maySend: true,
    mayCancelChildren: true,
  };
}

export const scoutDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_SCOUT,
  kind: "agent",
  title: "Repository scout",
  description: "Answer a focused repository question with path-grounded evidence.",
  input: ScoutRequestSchema,
  output: ScoutReportSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as a read-only repository scout. Search narrowly, cite concrete paths and lines, distinguish evidence from inference, and do not edit files.",
  },
  tools: { allow: ["read", "grep", "find", "ls"] },
  context,
  childCapabilities: none,
  limits: { timeoutMs: 300_000, maxTurns: 8, maxToolCalls: 50, maxRepairAttempts: 1 },
  persistence: "memory",
};

export const plannerDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_PLANNER,
  kind: "agent",
  title: "Planner",
  description:
    "Produce an executable, constrained plan and gather missing evidence through scouts only.",
  input: PlanRequestSchema,
  output: PlanResultSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as a planner. Analyze constraints and produce ordered implementation steps and checks. You are read-only. Delegate only focused evidence gaps to agent.scout.",
  },
  tools: {
    allow: ["read", "grep", "find", "ls", "phenix_run", "phenix_handle", "phenix_tasks"],
  },
  context,
  childCapabilities: capabilities([AGENT_SCOUT], 4),
  limits: { timeoutMs: 600_000, maxTurns: 12, maxToolCalls: 70, maxRepairAttempts: 2 },
  persistence: "memory",
};

export const architectDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_ARCHITECT,
  kind: "agent",
  title: "Architect",
  description: "Analyze module boundaries, ownership, data flow, and replacement seams without editing.",
  input: CriticRequestSchema,
  output: CriticReportSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as a software architect. Evaluate ownership, dependency direction, data derivation, replaceability, and unnecessary wrappers. Remain read-only and ground findings in the actual repository.",
  },
  tools: {
    allow: ["read", "grep", "find", "ls", "phenix_run", "phenix_handle", "phenix_tasks"],
  },
  context,
  childCapabilities: capabilities([AGENT_SCOUT], 4),
  limits: { timeoutMs: 600_000, maxTurns: 12, maxToolCalls: 80, maxRepairAttempts: 2 },
  persistence: "memory",
};

export const implementerDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_IMPLEMENTER,
  kind: "agent",
  title: "Mechanical implementer",
  description: "Apply an exact plan, edit files, and run targeted checks without redesigning it.",
  input: ImplementationRequestSchema,
  output: ChangeSetSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as a mechanical implementer. Follow the supplied objective and plan exactly. Make focused edits, run targeted checks, report every changed file, and surface unresolved issues instead of inventing architecture.",
  },
  tools: { allow: ["read", "grep", "find", "ls", "edit", "write", "bash", "phenix_tasks"] },
  context,
  childCapabilities: none,
  limits: { timeoutMs: 900_000, maxTurns: 18, maxToolCalls: 120, maxRepairAttempts: 2 },
  persistence: "memory",
};

export const testerDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_TESTER,
  kind: "agent",
  title: "Test analyst",
  description: "Interpret deterministic check output and identify concrete failures and coverage gaps.",
  input: TestRequestSchema,
  output: TestReportSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as a test analyst. Treat supplied command results as authoritative evidence, inspect relevant files when necessary, distinguish failures from missing coverage, and do not edit files.",
  },
  tools: { allow: ["read", "grep", "find", "ls"] },
  context,
  childCapabilities: none,
  limits: { timeoutMs: 420_000, maxTurns: 10, maxToolCalls: 50, maxRepairAttempts: 2 },
  persistence: "memory",
};

export const verifierDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_VERIFIER,
  kind: "agent",
  title: "Verifier",
  description:
    "Independently run deterministic checks and judge a claimed change without mutating it.",
  input: VerificationRequestSchema,
  output: VerificationResultSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as an independent verifier. Do not edit. Run the relevant deterministic checks, inspect the actual diff and behavior, and accept only with concrete evidence.",
  },
  tools: { allow: ["read", "grep", "find", "ls", "bash", "phenix_tasks"] },
  context,
  childCapabilities: none,
  limits: { timeoutMs: 600_000, maxTurns: 12, maxToolCalls: 80, maxRepairAttempts: 2 },
  persistence: "memory",
};

export const criticDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_CRITIC,
  kind: "agent",
  title: "Critic",
  description: "Search an artifact or handoff for contradictions, omissions, and ranked risks.",
  input: CriticRequestSchema,
  output: CriticReportSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as a read-only critic. Look for contradictions, unsafe assumptions, missing tests, and boundary violations. Rank findings by impact and ground them in evidence.",
  },
  tools: { allow: ["read", "grep", "find", "ls", "bash"] },
  context,
  childCapabilities: none,
  limits: { timeoutMs: 480_000, maxTurns: 10, maxToolCalls: 60, maxRepairAttempts: 2 },
  persistence: "memory",
};

export const finalizerDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_FINALIZER,
  kind: "agent",
  title: "Finalizer",
  description: "Synthesize completed child outcomes into a concise final handoff without new mutation.",
  input: ObjectiveRequestSchema,
  output: BaseResultSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as a finalizer. Synthesize only the supplied evidence and completed child outcomes, identify unresolved items explicitly, and do not start new implementation work.",
  },
  tools: { allow: ["read", "phenix_handle", "phenix_tasks"] },
  context,
  childCapabilities: none,
  limits: { timeoutMs: 300_000, maxTurns: 6, maxToolCalls: 24, maxRepairAttempts: 1 },
  persistence: "memory",
};

export const baseDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_BASE,
  kind: "agent",
  title: "Base agent",
  description: "General-purpose bounded coordinator and escape hatch for open-ended tasks.",
  input: ObjectiveRequestSchema,
  output: BaseResultSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Act as a bounded general coding agent. Compose typed agents and invariant workflows according to the task, own the final synthesis, and use local work directly when another session is unnecessary.",
  },
  tools: {
    allow: [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "bash",
      "phenix_run",
      "phenix_handle",
      "phenix_tasks",
    ],
  },
  context,
  childCapabilities: capabilities(ALL_DEFINITION_IDS, 4),
  limits: { timeoutMs: 1_200_000, maxTurns: 24, maxToolCalls: 160, maxRepairAttempts: 2 },
  persistence: "memory",
};

export const qaSynthesizerDefinition: AgentDefinition<unknown, unknown> = {
  id: AGENT_QA_SYNTHESIZER,
  kind: "agent",
  title: "QA synthesizer",
  description: "Deduplicate and rank deterministic and semantic QA reports.",
  input: QASynthesisRequestSchema,
  output: QAReportSchema,
  model: sessionModel,
  thinking: "route",
  prompt: {
    render: () =>
      "Synthesize the supplied deterministic checks and independent QA reports. Deduplicate overlapping observations, rank actionable findings by severity, preserve evidence, and do not perform repository work.",
  },
  tools: { allow: [] },
  context: { ...context, projectFiles: "none" },
  childCapabilities: none,
  limits: { timeoutMs: 300_000, maxTurns: 6, maxToolCalls: 4, maxRepairAttempts: 2 },
  persistence: "memory",
};

export const agentDefinitions = [
  scoutDefinition,
  plannerDefinition,
  architectDefinition,
  implementerDefinition,
  testerDefinition,
  verifierDefinition,
  criticDefinition,
  finalizerDefinition,
  baseDefinition,
  qaSynthesizerDefinition,
] as const;
