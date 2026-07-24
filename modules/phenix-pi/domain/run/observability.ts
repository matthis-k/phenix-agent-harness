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

export function defaultActivity(input: {
  readonly definitionId: DefinitionId;
  readonly kind: RunKind;
  readonly state: RunState;
}): RunActivityChangedData {
  if (input.state === "created" || input.state === "starting") {
    return { phase: "starting", summary: "Starting run", source: "derived" };
  }
  if (input.state === "waiting") {
    return { phase: "waiting", summary: "Waiting for dependencies", source: "derived" };
  }
  if (input.state === "completing") {
    return { phase: "finishing", summary: "Finalizing result", source: "derived" };
  }
  if (["completed", "failed", "cancelled", "orphaned"].includes(input.state)) {
    return { phase: "finishing", summary: terminalSummary(input.state), source: "derived" };
  }

  const id = String(input.definitionId);
  if (input.kind === "workflow") {
    return { phase: "planning", summary: "Running workflow", source: "derived" };
  }
  if (id.includes("scout")) {
    return { phase: "exploring", summary: "Exploring repository", source: "derived" };
  }
  if (id.includes("planner")) {
    return { phase: "planning", summary: "Preparing plan", source: "derived" };
  }
  if (id.includes("architect")) {
    return { phase: "analyzing", summary: "Analyzing architecture", source: "derived" };
  }
  if (id.includes("implementer")) {
    return { phase: "editing", summary: "Implementing changes", source: "derived" };
  }
  if (id.includes("tester")) {
    return { phase: "testing", summary: "Running test analysis", source: "derived" };
  }
  if (id.includes("verifier")) {
    return { phase: "verifying", summary: "Verifying changes", source: "derived" };
  }
  if (id.includes("critic")) {
    return { phase: "reviewing", summary: "Reviewing evidence", source: "derived" };
  }
  if (id.includes("finalizer") || id.includes("synthesizer")) {
    return { phase: "summarizing", summary: "Preparing final handoff", source: "derived" };
  }
  if (id.includes("dispatcher") || id.includes("coordinator")) {
    return { phase: "delegating", summary: "Coordinating execution", source: "derived" };
  }
  return { phase: "thinking", summary: "Working", source: "derived" };
}

export function workflowNodeActivity(nodeId: string): RunActivityChangedData {
  const normalized = nodeId.toLowerCase();
  const phase: ActivityPhase = normalized.includes("plan")
    ? "planning"
    : normalized.includes("implement") || normalized.includes("fix")
      ? "editing"
      : normalized.includes("test")
        ? "testing"
        : normalized.includes("verify")
          ? "verifying"
          : normalized.includes("review") || normalized.includes("critic")
            ? "reviewing"
            : normalized.includes("final") || normalized.includes("synth")
              ? "summarizing"
              : normalized.includes("wait") || normalized.includes("join")
                ? "waiting"
                : "analyzing";
  return {
    phase,
    summary: "Running workflow node",
    target: nodeId,
    source: "derived",
  };
}

function terminalSummary(state: RunState): string {
  return state === "completed"
    ? "Completed"
    : state === "failed"
      ? "Failed"
      : state === "cancelled"
        ? "Cancelled"
        : "Orphaned";
}
