export interface WorkflowTurnRequirement {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userTask: string;
  readonly requiredAgents: readonly string[];
}

export interface WorkflowToolInvocation {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface WorkflowToolOutcome extends WorkflowToolInvocation {
  readonly isError: boolean;
  readonly authorityResolved: boolean;
  readonly currentState?: string;
  readonly nextRequiredAgents: readonly string[];
}

export interface WorkflowTurnGate {
  beginTurn(requirement: WorkflowTurnRequirement): void;
  authorize(invocation: WorkflowToolInvocation): string | undefined;
  observe(outcome: WorkflowToolOutcome): void;
  clearSession(sessionId: string): void;
}

export type WorkflowTurnGateTrace = (record: Readonly<Record<string, unknown>>) => void;

interface RequiredTurnState {
  readonly kind: "required";
  readonly turnId: string;
  readonly userTask: string;
  readonly requiredAgents: readonly string[];
  readonly mustMatchUserTask: boolean;
}

interface TerminalTurnState {
  readonly kind: "terminal";
  readonly turnId: string;
  readonly workflowState: string;
}

type TurnGateState = RequiredTurnState | TerminalTurnState;

const TASK_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "in",
  "it",
  "of",
  "on",
  "or",
  "please",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

function uniqueAgents(agents: readonly string[]): readonly string[] {
  return [...new Set(agents.map((agent) => agent.trim()).filter(Boolean))].sort();
}

function workflowAction(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.action === "string" ? input.action : undefined;
}

function workflowAgent(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.agent === "string" ? input.agent : undefined;
}

function workflowTask(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.task === "string" ? input.task.trim() : undefined;
}

function skillReadPath(invocation: WorkflowToolInvocation): string | undefined {
  if (invocation.toolName !== "read") return undefined;
  const candidate =
    typeof invocation.input.path === "string"
      ? invocation.input.path
      : typeof invocation.input.file_path === "string"
        ? invocation.input.file_path
        : undefined;
  if (!candidate || !/(^|[\\/])SKILL\.md$/i.test(candidate)) return undefined;
  return candidate;
}

function normalizedTaskTokens(value: string): readonly string[] {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2 && !TASK_STOP_WORDS.has(token)))];
}

function isHarnessPreflightTask(task: string, userTask: string): boolean {
  const normalized = task.toLowerCase();
  const normalizedUserTask = userTask.toLowerCase();
  const internalResource =
    /(?:\bskill(?:\s+file)?\b|skill\.md|agents\.md|\/nix\/store\/|\bworkflow\s+(?:authority|contract)\b|\bcontract\s+id\b|\bharness\s+(?:bootstrap|preflight)\b)/i;
  const preflightAction = /\b(?:read|load|inspect|open|locate|parse|check)\b/i;
  return (
    internalResource.test(normalized) &&
    preflightAction.test(normalized) &&
    !internalResource.test(normalizedUserTask)
  );
}

function taskMatchesUserRequest(task: string, userTask: string): boolean {
  if (isHarnessPreflightTask(task, userTask)) return false;

  const userTokens = normalizedTaskTokens(userTask);
  if (userTokens.length === 0) return true;
  const delegatedTokens = new Set(normalizedTaskTokens(task));
  const overlap = userTokens.filter((token) => delegatedTokens.has(token)).length;
  const requiredOverlap = userTokens.length >= 3 ? 2 : 1;
  return overlap >= requiredOverlap;
}

class WorkflowTurnGateImpl implements WorkflowTurnGate {
  private readonly stateBySession = new Map<string, TurnGateState>();
  private readonly trace?: WorkflowTurnGateTrace;

  constructor(trace?: WorkflowTurnGateTrace) {
    this.trace = trace;
  }

  private emit(record: Readonly<Record<string, unknown>>): void {
    try {
      this.trace?.(record);
    } catch {
      // Diagnostics must never alter workflow authorization or execution.
    }
  }

  beginTurn(requirement: WorkflowTurnRequirement): void {
    const requiredAgents = uniqueAgents(requirement.requiredAgents);
    if (requiredAgents.length === 0) {
      this.stateBySession.delete(requirement.sessionId);
      this.emit({
        boundary: "workflow_gate.open",
        sessionId: requirement.sessionId,
        turnId: requirement.turnId,
        reason: "no-required-transition",
      });
      return;
    }

    this.stateBySession.set(requirement.sessionId, {
      kind: "required",
      turnId: requirement.turnId,
      userTask: requirement.userTask.trim(),
      requiredAgents,
      mustMatchUserTask: true,
    });
    this.emit({
      boundary: "workflow_gate.required",
      sessionId: requirement.sessionId,
      turnId: requirement.turnId,
      requiredAgents,
      taskMatchRequired: true,
    });
  }

  authorize(invocation: WorkflowToolInvocation): string | undefined {
    const state = this.stateBySession.get(invocation.sessionId);
    if (!state) return undefined;
    if (invocation.turnId !== state.turnId) {
      this.stateBySession.delete(invocation.sessionId);
      return undefined;
    }

    const deny = (reason: string, requiredAgents: readonly string[] = []): string => {
      this.emit({
        boundary: "workflow_gate.blocked",
        sessionId: invocation.sessionId,
        turnId: state.turnId,
        toolName: invocation.toolName,
        requiredAgents,
        reason,
      });
      return reason;
    };

    if (state.kind === "terminal") {
      return deny(
        `The Phenix workflow reached terminal state ${JSON.stringify(state.workflowState)} after a failed required delegation. ` +
          "No further execution is legal in this turn. Report the original workflow failure; a new user turn may retry with a fresh workflow.",
      );
    }

    const preflightPath = skillReadPath(invocation);
    if (preflightPath) {
      this.emit({
        boundary: "workflow_gate.preflight",
        sessionId: invocation.sessionId,
        turnId: state.turnId,
        toolName: invocation.toolName,
        resourceKind: "skill",
      });
      return undefined;
    }

    if (invocation.toolName !== "phenix_workflow") {
      return deny(
        `The current Phenix workflow requires delegation before ${invocation.toolName}. ` +
          "Local SKILL.md reads are allowed for preflight. Then call phenix_workflow with " +
          `action=spawn and one of: ${state.requiredAgents.join(", ")}.`,
        state.requiredAgents,
      );
    }

    const action = workflowAction(invocation.input);
    if (action !== "spawn") {
      return deny(
        "The current Phenix workflow requires action=spawn before other execution. " +
          `Choose one of: ${state.requiredAgents.join(", ")}.`,
        state.requiredAgents,
      );
    }

    const agent = workflowAgent(invocation.input);
    if (!agent || !state.requiredAgents.includes(agent)) {
      return deny(
        `Agent ${agent ? JSON.stringify(agent) : "<missing>"} is not a currently required target. ` +
          `Choose one of: ${state.requiredAgents.join(", ")}.`,
        state.requiredAgents,
      );
    }

    const task = workflowTask(invocation.input);
    if (!task) {
      return deny(
        "Required workflow delegation needs a non-empty task derived from the user request.",
        state.requiredAgents,
      );
    }
    if (state.mustMatchUserTask && !taskMatchesUserRequest(task, state.userTask)) {
      return deny(
        "The delegated task must be a bounded part of the user's request. " +
          "Do not delegate skill loading, contract loading, workflow inspection, or other Phenix harness preflight.",
        state.requiredAgents,
      );
    }

    this.emit({
      boundary: "workflow_gate.admitted",
      sessionId: invocation.sessionId,
      turnId: state.turnId,
      toolName: invocation.toolName,
      agent,
      taskMatchRequired: state.mustMatchUserTask,
    });
    return undefined;
  }

  observe(outcome: WorkflowToolOutcome): void {
    const state = this.stateBySession.get(outcome.sessionId);
    if (state?.kind !== "required" || outcome.turnId !== state.turnId) return;
    if (outcome.toolName !== "phenix_workflow" || workflowAction(outcome.input) !== "spawn") {
      return;
    }

    const nextRequiredAgents = uniqueAgents(outcome.nextRequiredAgents);
    if (outcome.isError) {
      this.emit({
        boundary: "workflow_gate.failed",
        sessionId: outcome.sessionId,
        turnId: state.turnId,
        agent: workflowAgent(outcome.input),
        requiredAgents: state.requiredAgents,
        authorityResolved: outcome.authorityResolved,
        currentState: outcome.currentState,
      });

      if (!outcome.authorityResolved) return;
      if (nextRequiredAgents.length > 0) {
        this.stateBySession.set(outcome.sessionId, {
          kind: "required",
          turnId: state.turnId,
          userTask: state.userTask,
          requiredAgents: nextRequiredAgents,
          mustMatchUserTask: false,
        });
        this.emit({
          boundary: "workflow_gate.required",
          sessionId: outcome.sessionId,
          turnId: state.turnId,
          requiredAgents: nextRequiredAgents,
          taskMatchRequired: false,
          reason: "authority-reconciled-after-failure",
        });
        return;
      }

      if (outcome.currentState === "failed") {
        this.stateBySession.set(outcome.sessionId, {
          kind: "terminal",
          turnId: state.turnId,
          workflowState: outcome.currentState,
        });
        this.emit({
          boundary: "workflow_gate.terminal",
          sessionId: outcome.sessionId,
          turnId: state.turnId,
          workflowState: outcome.currentState,
        });
        return;
      }

      this.stateBySession.delete(outcome.sessionId);
      this.emit({
        boundary: "workflow_gate.open",
        sessionId: outcome.sessionId,
        turnId: state.turnId,
        reason: "authority-reconciled-after-failure",
        currentState: outcome.currentState,
      });
      return;
    }

    if (nextRequiredAgents.length > 0) {
      this.stateBySession.set(outcome.sessionId, {
        kind: "required",
        turnId: state.turnId,
        userTask: state.userTask,
        requiredAgents: nextRequiredAgents,
        mustMatchUserTask: false,
      });
      this.emit({
        boundary: "workflow_gate.required",
        sessionId: outcome.sessionId,
        turnId: state.turnId,
        requiredAgents: nextRequiredAgents,
        taskMatchRequired: false,
        reason: "authority-advanced",
      });
      return;
    }

    this.stateBySession.delete(outcome.sessionId);
    this.emit({
      boundary: "workflow_gate.fulfilled",
      sessionId: outcome.sessionId,
      turnId: state.turnId,
      agent: workflowAgent(outcome.input),
    });
  }

  clearSession(sessionId: string): void {
    this.stateBySession.delete(sessionId);
  }
}

export function createWorkflowTurnGate(
  input: { readonly trace?: WorkflowTurnGateTrace } = {},
): WorkflowTurnGate {
  return new WorkflowTurnGateImpl(input.trace);
}
