import type { RunId } from "../shared.ts";

export type ProjectId = string & { readonly __brand: "ProjectId" };
export type DecisionId = string & { readonly __brand: "DecisionId" };
export type InterventionId = string & { readonly __brand: "InterventionId" };

export type DecisionType = "research" | "prototype" | "grilling" | "task";
export type DecisionMode = "afk" | "hitl";
export type DecisionState = "open" | "claimed" | "awaiting_user" | "resolved" | "out_of_scope";
export type InterventionUrgency = "normal" | "urgent";

export interface ProjectActor {
  readonly rootRunId: RunId;
  readonly runId: RunId;
  readonly sessionId?: string;
}

export interface ProjectDestination {
  readonly outcome: string;
  readonly useCase: string;
  readonly doneWhen: readonly string[];
  readonly nonGoals: readonly string[];
}

export interface ProjectDecisionInput {
  readonly id?: DecisionId;
  readonly title: string;
  readonly question: string;
  readonly type: DecisionType;
  readonly mode: DecisionMode;
  readonly dependsOn?: readonly DecisionId[];
}

export interface ProjectDecisionClaim {
  readonly actor: ProjectActor;
  readonly claimedAt: string;
}

export interface ProjectDecisionResolution {
  readonly summary: string;
  readonly rationale: string;
  readonly evidence: readonly string[];
  readonly consequences: readonly string[];
  readonly resolvedAt: string;
  readonly actor: ProjectActor;
}

export interface ProjectIssueLink {
  readonly issueNumber: number;
  readonly url: string;
}

export interface ProjectDecision extends Omit<ProjectDecisionInput, "id" | "dependsOn"> {
  readonly id: DecisionId;
  readonly dependsOn: readonly DecisionId[];
  readonly state: DecisionState;
  readonly createdAt: string;
  readonly claim?: ProjectDecisionClaim;
  readonly resolution?: ProjectDecisionResolution;
  readonly outOfScopeReason?: string;
  readonly issue?: ProjectIssueLink;
}

export interface ProjectIntervention {
  readonly id: InterventionId;
  readonly decisionId: DecisionId;
  readonly requestedBy: ProjectActor;
  readonly question: string;
  readonly context?: string;
  readonly options: readonly string[];
  readonly urgency: InterventionUrgency;
  readonly requestedAt: string;
  readonly status: "pending" | "answered";
  readonly answer?: string;
  readonly answeredAt?: string;
  readonly answeredBy?: ProjectActor;
  readonly delivered?: boolean;
}

export interface ProjectTrackerLink {
  readonly repository: string;
  readonly mapIssueNumber: number;
  readonly url: string;
}

export interface ProjectMap {
  readonly id: ProjectId;
  readonly revision: number;
  readonly title: string;
  readonly destination: ProjectDestination;
  readonly notes: readonly string[];
  readonly fog: readonly string[];
  readonly decisions: readonly ProjectDecision[];
  readonly interventions: readonly ProjectIntervention[];
  readonly tracker?: ProjectTrackerLink;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProjectEventType =
  | "project.created"
  | "project.fog.updated"
  | "project.tracker.linked"
  | "decision.added"
  | "decision.claimed"
  | "decision.released"
  | "decision.resolved"
  | "decision.out_of_scope"
  | "decision.issue.linked"
  | "intervention.requested"
  | "intervention.answered";

export interface ProjectEvent {
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly type: ProjectEventType;
  readonly at: string;
  readonly actor: ProjectActor;
  readonly data: unknown;
}

export interface UnsequencedProjectEvent extends Omit<ProjectEvent, "revision"> {}

export function projectId(value: string): ProjectId {
  return validateProjectId("project ID", value) as ProjectId;
}

export function decisionId(value: string): DecisionId {
  return validateProjectId("decision ID", value) as DecisionId;
}

export function interventionId(value: string): InterventionId {
  return validateProjectId("intervention ID", value) as InterventionId;
}

function validateProjectId(name: string, value: string): string {
  if (!value || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${name} contains unsupported characters: ${value}`);
  }
  return value;
}
