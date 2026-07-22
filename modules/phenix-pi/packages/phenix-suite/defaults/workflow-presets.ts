import type {
  DelegateTransition,
  DelegationPurpose,
  WorkflowActorRole,
  WorkflowDefinition,
  WorkflowOutputSchemaId,
  WorkflowStateId,
  WorkflowTransition,
} from "@matthis-k/phenix-flow/workflow-types.ts";
import { mkTransitionId } from "@matthis-k/phenix-flow/workflow-types.ts";
import type { AgentRole } from "@matthis-k/phenix-kernel/agents.ts";
import { agentClientRef, contractRef } from "@matthis-k/phenix-kernel/refs.ts";
import type { Difficulty } from "@matthis-k/phenix-kernel/task.ts";

import { PHENIX_DEFAULT_WORKFLOW } from "./workflow.ts";

const ALL_DIFFICULTIES: readonly Difficulty[] = ["D0", "D1", "D2", "D3"];

function delegate(args: {
  readonly id: string;
  readonly description: string;
  readonly difficulty?: readonly Difficulty[];
  readonly scope: "root" | "child" | "both";
  readonly actorRoles: readonly WorkflowActorRole[];
  readonly from: readonly WorkflowStateId[];
  readonly role: AgentRole;
  readonly purpose: DelegationPurpose;
  readonly category: "required" | "optional" | "repair";
  readonly outputSchemaId: WorkflowOutputSchemaId;
  readonly onAccepted: WorkflowStateId;
  readonly onRejected: WorkflowStateId;
  readonly allowedModes?: ReadonlyArray<"await" | "background">;
  readonly maxExecutions?: number;
}): DelegateTransition {
  const { id, role, outputSchemaId, allowedModes, ...rest } = args;
  return {
    kind: "delegate",
    id: mkTransitionId(id),
    ...rest,
    difficulty: args.difficulty ?? ALL_DIFFICULTIES,
    actorClients: rest.actorRoles.map((actorRole) => agentClientRef(actorRole)),
    agentClient: agentClientRef(role === null ? "base" : role),
    outputContract: contractRef(outputSchemaId),
    allowedModes: allowedModes ?? (rest.scope === "root" ? ["await", "background"] : ["await"]),
  };
}

const generalTransitions: WorkflowTransition[] = [
  delegate({
    id: "general.execute",
    description: "Execute a general task through a managed base session",
    scope: "root",
    actorRoles: ["coordinator"],
    from: ["classified"],
    role: null,
    purpose: "finalize",
    category: "required",
    outputSchemaId: "base-handoff",
    onAccepted: "completed",
    onRejected: "failed",
  }),
  delegate({
    id: "general.request-base",
    description:
      "Delegate one bounded ad-hoc assignment to a general-purpose child when no specialized role fits",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: null,
    purpose: "nested-evidence",
    category: "optional",
    outputSchemaId: "base-handoff",
    onAccepted: "executing",
    onRejected: "executing",
    maxExecutions: 2,
  }),
  delegate({
    id: "general.request-scout",
    description: "Delegate repository discovery when additional evidence is useful",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: "scout",
    purpose: "nested-evidence",
    category: "optional",
    outputSchemaId: "scout-handoff",
    onAccepted: "executing",
    onRejected: "executing",
    maxExecutions: 1,
  }),
  delegate({
    id: "general.request-planner",
    description: "Delegate a bounded plan when sequencing, dependencies, or risk need separate analysis",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: "planner",
    purpose: "produce-plan",
    category: "optional",
    outputSchemaId: "planner-handoff",
    onAccepted: "executing",
    onRejected: "executing",
    maxExecutions: 1,
  }),
  delegate({
    id: "general.request-architect",
    description: "Delegate architecture analysis when the task crosses boundaries",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: "architect",
    purpose: "nested-review",
    category: "optional",
    outputSchemaId: "architecture-handoff",
    onAccepted: "executing",
    onRejected: "executing",
    maxExecutions: 1,
  }),
  delegate({
    id: "general.request-implementer",
    description: "Delegate code changes when the general task requires implementation",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: "implementer",
    purpose: "implement",
    category: "optional",
    outputSchemaId: "implementation-handoff",
    onAccepted: "executing",
    onRejected: "executing",
    maxExecutions: 1,
  }),
  delegate({
    id: "general.request-tester",
    description: "Delegate verification when independent test evidence is useful",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: "tester",
    purpose: "nested-testing",
    category: "optional",
    outputSchemaId: "test-handoff",
    onAccepted: "executing",
    onRejected: "executing",
    maxExecutions: 1,
  }),
  delegate({
    id: "general.request-critic",
    description: "Delegate an independent challenge review",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: "critic",
    purpose: "nested-review",
    category: "optional",
    outputSchemaId: "critic-handoff",
    onAccepted: "executing",
    onRejected: "executing",
    maxExecutions: 1,
  }),
  delegate({
    id: "general.request-finalizer",
    description:
      "Delegate independent synthesis of collected evidence into a concise final handoff",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: "finalizer",
    purpose: "finalize",
    category: "optional",
    outputSchemaId: "finalizer-handoff",
    onAccepted: "executing",
    onRejected: "executing",
    maxExecutions: 1,
  }),
];

const qaTransitions: WorkflowTransition[] = [
  delegate({
    id: "qa.integrate",
    description: "Integrate a structured quality-assurance review",
    scope: "root",
    actorRoles: ["coordinator"],
    from: ["classified"],
    role: null,
    purpose: "finalize",
    category: "required",
    outputSchemaId: "base-handoff",
    onAccepted: "completed",
    onRejected: "failed",
  }),
  delegate({
    id: "qa.scout",
    description: "Inventory repository topology, tests, hotspots, and evidence locations",
    scope: "child",
    actorRoles: ["base"],
    from: ["executing"],
    role: "scout",
    purpose: "nested-evidence",
    category: "required",
    outputSchemaId: "scout-handoff",
    onAccepted: "qa-evidence-ready",
    onRejected: "qa-evidence-ready",
    maxExecutions: 1,
  }),
  delegate({
    id: "qa.test",
    description: "Run deterministic QA, project checks, metrics, and analyzer coverage",
    scope: "child",
    actorRoles: ["base"],
    from: ["qa-evidence-ready"],
    role: "tester",
    purpose: "nested-testing",
    category: "required",
    outputSchemaId: "test-handoff",
    onAccepted: "qa-tests-ready",
    onRejected: "qa-tests-ready",
    maxExecutions: 1,
  }),
  delegate({
    id: "qa.architecture",
    description: "Review dependency direction, cohesion, state machines, and module boundaries",
    scope: "child",
    actorRoles: ["base"],
    from: ["qa-tests-ready"],
    role: "architect",
    purpose: "nested-review",
    category: "required",
    outputSchemaId: "architecture-handoff",
    onAccepted: "qa-architecture-ready",
    onRejected: "qa-architecture-ready",
    maxExecutions: 1,
  }),
  delegate({
    id: "qa.critic",
    description: "Challenge findings across readability, integration, operability, and security",
    scope: "child",
    actorRoles: ["base"],
    from: ["qa-architecture-ready"],
    role: "critic",
    purpose: "nested-review",
    category: "required",
    outputSchemaId: "critic-handoff",
    onAccepted: "qa-review-ready",
    onRejected: "qa-review-ready",
    maxExecutions: 1,
  }),
];

export const PHENIX_GENERAL_WORKFLOW: WorkflowDefinition = {
  id: "phenix-general",
  initialState: "classified",
  transitions: generalTransitions,
};

export const PHENIX_IMPLEMENT_WORKFLOW = PHENIX_DEFAULT_WORKFLOW;

export const PHENIX_QA_WORKFLOW: WorkflowDefinition = {
  id: "phenix-qa",
  initialState: "classified",
  transitions: qaTransitions,
};

export const DEFAULT_WORKFLOWS: readonly WorkflowDefinition[] = [
  PHENIX_GENERAL_WORKFLOW,
  PHENIX_IMPLEMENT_WORKFLOW,
  PHENIX_QA_WORKFLOW,
];
