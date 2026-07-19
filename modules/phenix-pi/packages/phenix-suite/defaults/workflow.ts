import "./output-schemas.ts";
import { registerWorkflowDefinition } from "@matthis-k/phenix-flow/workflow-definitions.ts";
import type {
  AutomaticTransition,
  DelegateTransition,
  DelegationPurpose,
  TransitionCondition,
  WorkflowDefinition,
  WorkflowOutputSchemaId,
  WorkflowStateId,
  WorkflowTransition,
} from "@matthis-k/phenix-flow/workflow-types.ts";
import { mkTransitionId } from "@matthis-k/phenix-flow/workflow-types.ts";
import type { AgentKind, AgentRole } from "@matthis-k/phenix-kernel/agents.ts";
import { agentClientRef, contractRef } from "@matthis-k/phenix-kernel/refs.ts";
import type { Difficulty } from "@matthis-k/phenix-kernel/task.ts";

// ── Helper factories ────────────────────────────────────────────────────────

function clientIdForRole(role: AgentRole): string {
  return role === null ? "base" : role;
}

function actorClientRefs(roles: ReadonlyArray<"coordinator" | AgentKind>) {
  return roles.map((role) => agentClientRef(role));
}

function delegate(args: {
  readonly id: string;
  readonly difficulty: readonly Difficulty[];
  readonly scope: "root" | "child" | "both";
  readonly actorRoles: ReadonlyArray<"coordinator" | AgentKind>;
  readonly from: readonly WorkflowStateId[];
  readonly role: AgentRole;
  readonly purpose: DelegationPurpose;
  readonly description: string;
  readonly category: "required" | "optional" | "repair";
  readonly outputSchemaId: WorkflowOutputSchemaId;
  readonly allowedModes?: ReadonlyArray<"await" | "background">;
  readonly onAccepted: WorkflowStateId;
  readonly onRejected: WorkflowStateId;
  readonly condition?: TransitionCondition;
  readonly parallelGroup?: string;
  readonly maxExecutions?: number;
}): DelegateTransition {
  const { id: _id, allowedModes, role, outputSchemaId, ...rest } = args;
  return {
    kind: "delegate",
    id: mkTransitionId(_id),
    ...rest,
    actorClients: actorClientRefs(rest.actorRoles),
    agentClient: agentClientRef(clientIdForRole(role)),
    outputContract: contractRef(outputSchemaId),
    allowedModes: allowedModes ?? ["await"],
  };
}

function automatic(args: {
  readonly id: string;
  readonly difficulty: readonly Difficulty[];
  readonly from: WorkflowStateId;
  readonly to: WorkflowStateId;
  readonly condition: TransitionCondition;
  readonly description: string;
}): AutomaticTransition {
  const { id: _id, ...rest } = args;
  return { kind: "automatic", id: mkTransitionId(_id), ...rest };
}

// ── Common conditions ───────────────────────────────────────────────────────

const _ALWAYS: TransitionCondition = { kind: "always" };

const _D023: readonly Difficulty[] = ["D0", "D2", "D3"];
const _D01: readonly Difficulty[] = ["D0", "D1"];
const _D123: readonly Difficulty[] = ["D1", "D2", "D3"];
const _D23: readonly Difficulty[] = ["D2", "D3"];
const _D3_ONLY: readonly Difficulty[] = ["D3"];
const ALL_DIFF: readonly Difficulty[] = ["D0", "D1", "D2", "D3"];

const ROOT: "root" = "root";
const CHILD: "child" = "child";
const _BOTH: "both" = "both";

const COORDINATOR: ReadonlyArray<"coordinator" | AgentKind> = ["coordinator"];
const PLANNER: ReadonlyArray<"coordinator" | AgentKind> = ["planner"];
const ARCHITECT: ReadonlyArray<"coordinator" | AgentKind> = ["architect"];
const IMPLEMENTER: ReadonlyArray<"coordinator" | AgentKind> = ["implementer"];
const TESTER: ReadonlyArray<"coordinator" | AgentKind> = ["tester"];
const CRITIC: ReadonlyArray<"coordinator" | AgentKind> = ["critic"];
const FINALIZER: ReadonlyArray<"coordinator" | AgentKind> = ["finalizer"];
const SCOUT: ReadonlyArray<"coordinator" | AgentKind> = ["scout"];

const REQUIRED: "required" = "required";
const OPTIONAL: "optional" = "optional";

// ── Condition: cross-cutting design required ────────────────────────────────

const crossCuttingRequired: TransitionCondition = {
  kind: "all",
  conditions: [{ kind: "workflow-fact", key: "crossCuttingDesignRequired", equals: true }],
};

const _crossCuttingNotRequired: TransitionCondition = {
  kind: "not",
  condition: { kind: "workflow-fact", key: "crossCuttingDesignRequired", equals: true },
};

// ── Condition: requires dedicated testing ───────────────────────────────────

const requiresDedicatedTesting: TransitionCondition = {
  kind: "workflow-fact",
  key: "requiresDedicatedTesting",
  equals: true,
};

const doesNotRequireDedicatedTesting: TransitionCondition = {
  kind: "not",
  condition: { kind: "workflow-fact", key: "requiresDedicatedTesting", equals: true },
};

// ── Condition: profile coupling >= 2 or breadth >= 2 ────────────────────────

const architectureProfileHint: TransitionCondition = {
  kind: "any",
  conditions: [
    { kind: "profile-at-least", field: "coupling", value: 2 },
    { kind: "profile-at-least", field: "breadth", value: 2 },
  ],
};

const architectureRequired: TransitionCondition = {
  kind: "any",
  conditions: [crossCuttingRequired, architectureProfileHint],
};

const architectureNotRequired: TransitionCondition = {
  kind: "not",
  condition: architectureRequired,
};

// ── D3 discovery completion ─────────────────────────────────────────────────

const d3DiscoveryComplete: TransitionCondition = {
  kind: "all",
  conditions: [
    { kind: "transition-completed", transitionId: mkTransitionId("d3.scout-repository") },
    { kind: "transition-completed", transitionId: mkTransitionId("d3.scout-tests") },
    { kind: "transition-completed", transitionId: mkTransitionId("d3.scout-constraints") },
  ],
};

// ── D3 discovery not yet complete ───────────────────────────────────────────

const _d3DiscoveryNotComplete: TransitionCondition = {
  kind: "not",
  condition: d3DiscoveryComplete,
};

// ── Transitions ─────────────────────────────────────────────────────────────

const transitions: WorkflowTransition[] = [];

// ═════════════════════════════════════════════════════════════════════════════
// D0 — Direct or mechanical task
// ═════════════════════════════════════════════════════════════════════════════

// D0 scout (optional discovery, max once)
transitions.push(
  delegate({
    id: "d0.scout",
    description: "Optional scout for repository discovery",
    difficulty: ["D0"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "scout",
    purpose: "discover-repository",
    category: OPTIONAL,
    outputSchemaId: "scout-handoff",
    onAccepted: "classified",
    onRejected: "classified",
    maxExecutions: 1,
  }),
);

// D0 execute-base
transitions.push(
  delegate({
    id: "d0.execute-base",
    description: "Execute a bounded non-code task as a base agent",
    difficulty: ["D0"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: null,
    purpose: "finalize",
    category: REQUIRED,
    outputSchemaId: "base-handoff",
    onAccepted: "completed",
    onRejected: "failed",
  }),
);

// D0 execute-code
transitions.push(
  delegate({
    id: "d0.execute-code",
    description: "Execute a mechanical code change",
    difficulty: ["D0"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "implementer",
    purpose: "implement",
    category: REQUIRED,
    outputSchemaId: "implementation-handoff",
    onAccepted: "completed",
    onRejected: "failed",
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// D1 — Bounded implementation task
// ═════════════════════════════════════════════════════════════════════════════

// D1 scout (optional discovery, max once)
transitions.push(
  delegate({
    id: "d1.scout",
    description: "Optional scout for repository discovery",
    difficulty: ["D1"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "scout",
    purpose: "discover-repository",
    category: OPTIONAL,
    outputSchemaId: "scout-handoff",
    onAccepted: "classified",
    onRejected: "classified",
    maxExecutions: 1,
  }),
);

// D1 plan (optional)
transitions.push(
  delegate({
    id: "d1.plan",
    description: "Optional plan for multi-step work",
    difficulty: ["D1"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "planner",
    purpose: "produce-plan",
    category: OPTIONAL,
    outputSchemaId: "planner-handoff",
    onAccepted: "plan-ready",
    onRejected: "classified",
    maxExecutions: 1,
  }),
);

// D1 execute-base
transitions.push(
  delegate({
    id: "d1.execute-base",
    description: "Execute a bounded non-code task as a base agent",
    difficulty: ["D1"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified", "plan-ready"],
    role: null,
    purpose: "finalize",
    category: REQUIRED,
    outputSchemaId: "base-handoff",
    onAccepted: "completed",
    onRejected: "failed",
  }),
);

// D1 implement (from classified or plan-ready)
transitions.push(
  delegate({
    id: "d1.implement",
    description: "Implement a contained change",
    difficulty: ["D1"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified", "plan-ready"],
    role: "implementer",
    purpose: "implement",
    category: REQUIRED,
    outputSchemaId: "implementation-handoff",
    onAccepted: "implementation-ready",
    onRejected: "failed",
  }),
);

// D1 test (from implementation-ready, when dedicated testing is needed)
transitions.push(
  delegate({
    id: "d1.test",
    description: "Run dedicated testing",
    difficulty: ["D1"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["implementation-ready"],
    role: "tester",
    purpose: "test",
    category: REQUIRED,
    outputSchemaId: "test-handoff",
    onAccepted: "completed",
    onRejected: "failed",
    condition: requiresDedicatedTesting,
  }),
);

// D1 automatic: implementation-ready → completed when no dedicated testing
transitions.push(
  automatic({
    id: "d1.auto-complete",
    description: "Auto-complete when dedicated testing is not required",
    difficulty: ["D1"],
    from: "implementation-ready",
    to: "completed",
    condition: doesNotRequireDedicatedTesting,
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// D2 — Complex or cross-component task
// ═════════════════════════════════════════════════════════════════════════════

// D2 scout (optional, max once)
transitions.push(
  delegate({
    id: "d2.scout",
    description: "Optional scout for repository discovery",
    difficulty: ["D2"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "scout",
    purpose: "discover-repository",
    category: OPTIONAL,
    outputSchemaId: "scout-handoff",
    onAccepted: "classified",
    onRejected: "classified",
    maxExecutions: 1,
  }),
);

// D2 plan (required)
transitions.push(
  delegate({
    id: "d2.plan",
    description: "Produce a plan for complex work",
    difficulty: ["D2"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "planner",
    purpose: "produce-plan",
    category: REQUIRED,
    outputSchemaId: "planner-handoff",
    onAccepted: "plan-ready",
    onRejected: "failed",
    maxExecutions: 1,
  }),
);

// D2 architect (required when cross-cutting or high coupling/breadth)
transitions.push(
  delegate({
    id: "d2.architect",
    description: "Produce cross-cutting architecture design",
    difficulty: ["D2"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["plan-ready"],
    role: "architect",
    purpose: "produce-architecture",
    category: REQUIRED,
    outputSchemaId: "architecture-handoff",
    onAccepted: "design-ready",
    onRejected: "failed",
    condition: architectureRequired,
    maxExecutions: 1,
  }),
);

// D2 implement-from-plan (when architecture not required)
transitions.push(
  delegate({
    id: "d2.implement-from-plan",
    description: "Implement from an accepted plan (no architecture needed)",
    difficulty: ["D2"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["plan-ready"],
    role: "implementer",
    purpose: "implement",
    category: REQUIRED,
    outputSchemaId: "implementation-handoff",
    onAccepted: "implementation-ready",
    onRejected: "failed",
    condition: architectureNotRequired,
  }),
);

// D2 implement-from-design
transitions.push(
  delegate({
    id: "d2.implement-from-design",
    description: "Implement from an accepted architecture design",
    difficulty: ["D2"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["design-ready"],
    role: "implementer",
    purpose: "implement",
    category: REQUIRED,
    outputSchemaId: "implementation-handoff",
    onAccepted: "implementation-ready",
    onRejected: "failed",
  }),
);

// D2 test (required)
transitions.push(
  delegate({
    id: "d2.test",
    description: "Run dedicated testing",
    difficulty: ["D2"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["implementation-ready"],
    role: "tester",
    purpose: "test",
    category: REQUIRED,
    outputSchemaId: "test-handoff",
    onAccepted: "tests-ready",
    onRejected: "failed",
  }),
);

// D2 finalize (required)
transitions.push(
  delegate({
    id: "d2.finalize",
    description: "Integrate handoffs and report final result",
    difficulty: ["D2"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["tests-ready"],
    role: "finalizer",
    purpose: "finalize",
    category: REQUIRED,
    outputSchemaId: "finalizer-handoff",
    onAccepted: "completed",
    onRejected: "failed",
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// D3 — Critical, broad, or high-consequence task
// ═════════════════════════════════════════════════════════════════════════════

const D3_DISCOVERY_GROUP = "d3.discovery";

// D3 discovery scouts (parallel, root background allowed)
transitions.push(
  delegate({
    id: "d3.scout-repository",
    description: "Discover repository code topology",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "scout",
    purpose: "discover-repository",
    category: REQUIRED,
    outputSchemaId: "scout-handoff",
    allowedModes: ["await", "background"],
    onAccepted: "classified",
    onRejected: "failed",
    maxExecutions: 1,
    parallelGroup: D3_DISCOVERY_GROUP,
  }),
);

transitions.push(
  delegate({
    id: "d3.scout-tests",
    description: "Discover tests and runtime behavior",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "scout",
    purpose: "discover-tests",
    category: REQUIRED,
    outputSchemaId: "scout-handoff",
    allowedModes: ["await", "background"],
    onAccepted: "classified",
    onRejected: "failed",
    maxExecutions: 1,
    parallelGroup: D3_DISCOVERY_GROUP,
  }),
);

transitions.push(
  delegate({
    id: "d3.scout-constraints",
    description: "Discover external constraints and dependencies",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "scout",
    purpose: "discover-constraints",
    category: REQUIRED,
    outputSchemaId: "scout-handoff",
    allowedModes: ["await", "background"],
    onAccepted: "classified",
    onRejected: "failed",
    maxExecutions: 1,
    parallelGroup: D3_DISCOVERY_GROUP,
  }),
);

// D3 plan (only after all discovery scouts complete)
transitions.push(
  delegate({
    id: "d3.plan",
    description: "Produce a comprehensive plan",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["classified"],
    role: "planner",
    purpose: "produce-plan",
    category: REQUIRED,
    outputSchemaId: "planner-handoff",
    onAccepted: "plan-ready",
    onRejected: "failed",
    condition: d3DiscoveryComplete,
    maxExecutions: 1,
  }),
);

// D3 architect (required)
transitions.push(
  delegate({
    id: "d3.architect",
    description: "Produce architecture design",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["plan-ready"],
    role: "architect",
    purpose: "produce-architecture",
    category: REQUIRED,
    outputSchemaId: "architecture-handoff",
    onAccepted: "design-ready",
    onRejected: "failed",
    maxExecutions: 1,
  }),
);

// D3 implement
transitions.push(
  delegate({
    id: "d3.implement",
    description: "Implement according to architecture",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["design-ready"],
    role: "implementer",
    purpose: "implement",
    category: REQUIRED,
    outputSchemaId: "implementation-handoff",
    onAccepted: "implementation-ready",
    onRejected: "failed",
  }),
);

// D3 test
transitions.push(
  delegate({
    id: "d3.test",
    description: "Run comprehensive testing",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["implementation-ready"],
    role: "tester",
    purpose: "test",
    category: REQUIRED,
    outputSchemaId: "test-handoff",
    onAccepted: "tests-ready",
    onRejected: "failed",
  }),
);

// D3 finalize
transitions.push(
  delegate({
    id: "d3.finalize",
    description: "Integrate and finalize all handoffs",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["tests-ready"],
    role: "finalizer",
    purpose: "finalize",
    category: REQUIRED,
    outputSchemaId: "finalizer-handoff",
    onAccepted: "final-review-ready",
    onRejected: "failed",
  }),
);

// D3 final-review (required critic gate)
transitions.push(
  delegate({
    id: "d3.final-review",
    description: "Final consistency review",
    difficulty: ["D3"],
    scope: ROOT,
    actorRoles: COORDINATOR,
    from: ["final-review-ready"],
    role: "critic",
    purpose: "review-final",
    category: REQUIRED,
    outputSchemaId: "critic-handoff",
    onAccepted: "completed",
    onRejected: "failed",
    maxExecutions: 1,
  }),
);

// ═════════════════════════════════════════════════════════════════════════════
// Child-local nested transitions
// ═════════════════════════════════════════════════════════════════════════════

function nestedDelegate(args: {
  readonly id: string;
  readonly actorRoles: ReadonlyArray<"coordinator" | AgentKind>;
  readonly from: WorkflowStateId;
  readonly role: AgentKind;
  readonly purpose: DelegationPurpose;
  readonly description: string;
  readonly outputSchemaId: WorkflowOutputSchemaId;
}): void {
  transitions.push(
    delegate({
      ...args,
      difficulty: ALL_DIFF,
      scope: CHILD,
      from: [args.from],
      category: OPTIONAL,
      onAccepted: args.from,
      onRejected: args.from,
      allowedModes: ["await"],
    }),
  );
}

// Planner nested children
nestedDelegate({
  id: "planner.request-scout",
  actorRoles: PLANNER,
  from: "planning",
  role: "scout",
  purpose: "nested-evidence",
  description: "Planner requests scout for evidence",
  outputSchemaId: "scout-handoff",
});
nestedDelegate({
  id: "planner.request-architect",
  actorRoles: PLANNER,
  from: "planning",
  role: "architect",
  purpose: "nested-review",
  description: "Planner requests architecture review",
  outputSchemaId: "architecture-handoff",
});
nestedDelegate({
  id: "planner.request-critic",
  actorRoles: PLANNER,
  from: "planning",
  role: "critic",
  purpose: "nested-review",
  description: "Planner requests critic review",
  outputSchemaId: "critic-handoff",
});

// Architect nested children
nestedDelegate({
  id: "architect.request-scout",
  actorRoles: ARCHITECT,
  from: "designing",
  role: "scout",
  purpose: "nested-evidence",
  description: "Architect requests scout for evidence",
  outputSchemaId: "scout-handoff",
});
nestedDelegate({
  id: "architect.request-critic",
  actorRoles: ARCHITECT,
  from: "designing",
  role: "critic",
  purpose: "nested-review",
  description: "Architect requests critic review",
  outputSchemaId: "critic-handoff",
});

// Implementer nested children
nestedDelegate({
  id: "implementer.request-scout",
  actorRoles: IMPLEMENTER,
  from: "implementing",
  role: "scout",
  purpose: "nested-evidence",
  description: "Implementer requests scout for evidence",
  outputSchemaId: "scout-handoff",
});
nestedDelegate({
  id: "implementer.request-tester",
  actorRoles: IMPLEMENTER,
  from: "implementing",
  role: "tester",
  purpose: "nested-testing",
  description: "Implementer requests tester",
  outputSchemaId: "test-handoff",
});
nestedDelegate({
  id: "implementer.request-critic",
  actorRoles: IMPLEMENTER,
  from: "implementing",
  role: "critic",
  purpose: "nested-review",
  description: "Implementer requests critic review",
  outputSchemaId: "critic-handoff",
});

// Tester nested children
nestedDelegate({
  id: "tester.request-scout",
  actorRoles: TESTER,
  from: "testing",
  role: "scout",
  purpose: "nested-evidence",
  description: "Tester requests scout for evidence",
  outputSchemaId: "scout-handoff",
});

// Critic nested children
nestedDelegate({
  id: "critic.request-scout",
  actorRoles: CRITIC,
  from: "reviewing",
  role: "scout",
  purpose: "nested-evidence",
  description: "Critic requests scout for evidence",
  outputSchemaId: "scout-handoff",
});
nestedDelegate({
  id: "critic.request-tester",
  actorRoles: CRITIC,
  from: "reviewing",
  role: "tester",
  purpose: "nested-testing",
  description: "Critic requests tester",
  outputSchemaId: "test-handoff",
});

// Finalizer nested children
nestedDelegate({
  id: "finalizer.request-critic",
  actorRoles: FINALIZER,
  from: "finalizing",
  role: "critic",
  purpose: "nested-review",
  description: "Finalizer requests critic review",
  outputSchemaId: "critic-handoff",
});

// Scout nested children
nestedDelegate({
  id: "scout.request-scout",
  actorRoles: SCOUT,
  from: "scouting",
  role: "scout",
  purpose: "nested-evidence",
  description: "Scout requests nested scout",
  outputSchemaId: "scout-handoff",
});

// ── Definition ──────────────────────────────────────────────────────────────

export const PHENIX_DEFAULT_WORKFLOW: WorkflowDefinition = {
  id: "phenix-default",
  initialState: "classified",
  transitions,
};

registerWorkflowDefinition(PHENIX_DEFAULT_WORKFLOW);

// ── Convenience lookups ─────────────────────────────────────────────────────

export function getWorkflowDefinition(id: string): WorkflowDefinition | undefined {
  if (id === "phenix-default") return PHENIX_DEFAULT_WORKFLOW;
  return undefined;
}

export function validateDefinition(def: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const t of def.transitions) {
    if (seenIds.has(t.id)) {
      errors.push(`Duplicate transition ID: ${t.id}`);
    }
    seenIds.add(t.id);
  }

  return errors;
}
