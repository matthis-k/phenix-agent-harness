import type { DefinitionId, RunId } from "../shared.ts";
import type { RunKind, RunState } from "./model.ts";

export const ACTIVITY_PHASES = [
  "starting",
  "thinking",
  "exploring",
  "planning",
  "analyzing",
  "editing",
  "testing",
  "verifying",
  "reviewing",
  "delegating",
  "waiting",
  "summarizing",
  "finishing",
] as const;

export type ActivityPhase = (typeof ACTIVITY_PHASES)[number];
export type ActivitySource = "derived" | "reported";

export interface RunActivity {
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly phase: ActivityPhase;
  readonly summary: string;
  readonly target?: string;
  readonly source: ActivitySource;
  readonly since: string;
  readonly sequence: number;
}

export interface RunActivityChangedData {
  readonly phase: ActivityPhase;
  readonly summary: string;
  readonly target?: string;
  readonly source: ActivitySource;
}

export type FactReliability = "observed" | "derived" | "reported";
export type FactSource = "runtime" | "tool" | "workflow" | "operation" | "agent-report";
export type FactKind =
  | "run-started"
  | "run-state-changed"
  | "file-read"
  | "search-performed"
  | "file-changed"
  | "command-finished"
  | "test-result"
  | "child-started"
  | "child-finished"
  | "workflow-transition"
  | "finding-reported"
  | "decision-reported"
  | "error-observed";

export interface RunFactProvenance {
  readonly eventId?: string;
  readonly toolCallId?: string;
  readonly childRunId?: RunId;
}

export interface RunFact {
  readonly id: string;
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly kind: FactKind;
  readonly source: FactSource;
  readonly summary: string;
  readonly subject?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly provenance: RunFactProvenance;
  readonly reliability: FactReliability;
}

export interface RunFactRecordedData {
  readonly kind: FactKind;
  readonly source: FactSource;
  readonly summary: string;
  readonly subject?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly provenance?: Omit<RunFactProvenance, "eventId">;
  readonly reliability: FactReliability;
}

type ActivityTemplate = Omit<RunActivityChangedData, "source" | "target">;

const STATE_ACTIVITIES: Partial<Record<RunState, ActivityTemplate>> = {
  created: { phase: "starting", summary: "Starting run" },
  starting: { phase: "starting", summary: "Starting run" },
  waiting: { phase: "waiting", summary: "Waiting for dependencies" },
  completing: { phase: "finishing", summary: "Finalizing result" },
  completed: { phase: "finishing", summary: "Completed" },
  failed: { phase: "finishing", summary: "Failed" },
  cancelled: { phase: "finishing", summary: "Cancelled" },
  orphaned: { phase: "finishing", summary: "Orphaned" },
};

const DEFINITION_ACTIVITIES = [
  [["scout"], "exploring", "Exploring repository"],
  [["planner"], "planning", "Preparing plan"],
  [["architect"], "analyzing", "Analyzing architecture"],
  [["implementer"], "editing", "Implementing changes"],
  [["tester"], "testing", "Running test analysis"],
  [["verifier"], "verifying", "Verifying changes"],
  [["critic"], "reviewing", "Reviewing evidence"],
  [["finalizer", "synthesizer"], "summarizing", "Preparing final handoff"],
  [["dispatcher", "coordinator"], "delegating", "Coordinating execution"],
] as const satisfies readonly (readonly [readonly string[], ActivityPhase, string])[];

const WORKFLOW_NODE_PHASES = [
  [["plan"], "planning"],
  [["implement", "fix"], "editing"],
  [["test"], "testing"],
  [["verify"], "verifying"],
  [["review", "critic"], "reviewing"],
  [["final", "synth"], "summarizing"],
  [["wait", "join"], "waiting"],
] as const satisfies readonly (readonly [readonly string[], ActivityPhase])[];

export function defaultActivity(input: {
  readonly definitionId: DefinitionId;
  readonly kind: RunKind;
  readonly state: RunState;
}): RunActivityChangedData {
  const stateActivity = STATE_ACTIVITIES[input.state];
  if (stateActivity) return derivedActivity(stateActivity);
  if (input.kind === "workflow") {
    return derivedActivity({ phase: "planning", summary: "Running workflow" });
  }

  const definitionId = String(input.definitionId);
  const matched = DEFINITION_ACTIVITIES.find(([terms]) =>
    terms.some((term) => definitionId.includes(term)),
  );
  const [, phase = "thinking", summary = "Working"] = matched ?? [];
  return derivedActivity({ phase, summary });
}

export function workflowNodeActivity(nodeId: string): RunActivityChangedData {
  const normalized = nodeId.toLowerCase();
  const matched = WORKFLOW_NODE_PHASES.find(([terms]) =>
    terms.some((term) => normalized.includes(term)),
  );
  return {
    phase: matched?.[1] ?? "analyzing",
    summary: "Running workflow node",
    target: nodeId,
    source: "derived",
  };
}

function derivedActivity(activity: ActivityTemplate): RunActivityChangedData {
  return { ...activity, source: "derived" };
}
