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
  readonly handleId?: string;
  readonly handleStatus?: string;
}

export interface WorkflowTurnGate {
  beginTurn(requirement: WorkflowTurnRequirement): void;
  authorize(invocation: WorkflowToolInvocation): string | undefined;
  observe(outcome: WorkflowToolOutcome): void;
  resumeTurn(sessionId: string, turnId: string): void;
  clearSession(sessionId: string): void;
}

export type WorkflowTurnGateTrace = (record: Readonly<Record<string, unknown>>) => void;

interface RequiredTurnState {
  readonly kind: "required";
  readonly turnId: string;
  readonly userTask: string;
  readonly requiredAgents: readonly string[];
}

interface DelegatedTurnState {
  readonly kind: "delegated";
  readonly turnId: string;
  readonly userTask: string;
  readonly requiredAgents: readonly string[];
  readonly agent: string;
  readonly handleId: string;
}

interface TerminalTurnState {
  readonly kind: "terminal";
  readonly turnId: string;
  readonly workflowState: string;
}

type TurnGateState = RequiredTurnState | DelegatedTurnState | TerminalTurnState;

const TERMINAL_HANDLE_STATES = new Set(["completed", "failed", "cancelled", "orphaned"]);

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

function handleId(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.id === "string" ? input.id : undefined;
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
    });
    this.emit({
      boundary: "workflow_gate.required",
      sessionId: requirement.sessionId,
      turnId: requirement.turnId,
      requiredAgents,
      preflightTaskRejected: true,
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

    if (state.kind === "delegated") {
      if (invocation.toolName === "phenix_agent") {
        const requestedHandle = handleId(invocation.input);
        if (requestedHandle === state.handleId) return undefined;
        return deny(
          `Required delegation is active under handle ${JSON.stringify(state.handleId)}. ` +
            `Use phenix_agent with id=${JSON.stringify(state.handleId)}; do not address a different handle.`,
          state.requiredAgents,
        );
      }
      if (
        invocation.toolName === "phenix_workflow" &&
        workflowAction(invocation.input) === "inspect"
      ) {
        return undefined;
      }
      return deny(
        `Required delegation is already active under handle ${JSON.stringify(state.handleId)}. ` +
          "Use phenix_agent with action=inspect, poll, await, send, or cancel to settle that execution before other repository work.",
        state.requiredAgents,
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
    if (isHarnessPreflightTask(task, state.userTask)) {
      return deny(
        "Required workflow delegation must describe user work, not skill loading, contract loading, workflow inspection, or other Phenix harness preflight.",
        state.requiredAgents,
      );
    }

    this.emit({
      boundary: "workflow_gate.admitted",
      sessionId: invocation.sessionId,
      turnId: state.turnId,
      toolName: invocation.toolName,
      agent,
      preflightTaskRejected: true,
    });
    return undefined;
  }

  observe(outcome: WorkflowToolOutcome): void {
    const state = this.stateBySession.get(outcome.sessionId);
    if (!state || outcome.turnId !== state.turnId) return;

    const reconcileAuthority = (
      requiredState: RequiredTurnState | DelegatedTurnState,
      reason: string,
      agent: string | undefined,
    ): void => {
      const nextRequiredAgents = uniqueAgents(outcome.nextRequiredAgents);

      if (outcome.isError) {
        this.emit({
          boundary: "workflow_gate.failed",
          sessionId: outcome.sessionId,
          turnId: requiredState.turnId,
          agent,
          requiredAgents: requiredState.requiredAgents,
          authorityResolved: outcome.authorityResolved,
          currentState: outcome.currentState,
          reason,
        });

        if (!outcome.authorityResolved) return;
        if (nextRequiredAgents.length > 0) {
          this.stateBySession.set(outcome.sessionId, {
            kind: "required",
            turnId: requiredState.turnId,
            userTask: requiredState.userTask,
            requiredAgents: nextRequiredAgents,
          });
          this.emit({
            boundary: "workflow_gate.required",
            sessionId: outcome.sessionId,
            turnId: requiredState.turnId,
            requiredAgents: nextRequiredAgents,
            reason: "authority-reconciled-after-failure",
          });
          return;
        }

        if (outcome.currentState === "failed") {
          this.stateBySession.set(outcome.sessionId, {
            kind: "terminal",
            turnId: requiredState.turnId,
            workflowState: outcome.currentState,
          });
          this.emit({
            boundary: "workflow_gate.terminal",
            sessionId: outcome.sessionId,
            turnId: requiredState.turnId,
            workflowState: outcome.currentState,
          });
          return;
        }

        this.stateBySession.delete(outcome.sessionId);
        this.emit({
          boundary: "workflow_gate.open",
          sessionId: outcome.sessionId,
          turnId: requiredState.turnId,
          reason: "authority-reconciled-after-failure",
          currentState: outcome.currentState,
        });
        return;
      }

      if (nextRequiredAgents.length > 0) {
        this.stateBySession.set(outcome.sessionId, {
          kind: "required",
          turnId: requiredState.turnId,
          userTask: requiredState.userTask,
          requiredAgents: nextRequiredAgents,
        });
        this.emit({
          boundary: "workflow_gate.required",
          sessionId: outcome.sessionId,
          turnId: requiredState.turnId,
          requiredAgents: nextRequiredAgents,
          reason: "authority-advanced",
        });
        return;
      }

      this.stateBySession.delete(outcome.sessionId);
      this.emit({
        boundary: "workflow_gate.fulfilled",
        sessionId: outcome.sessionId,
        turnId: requiredState.turnId,
        agent,
        reason,
      });
    };

    if (state.kind === "delegated") {
      if (outcome.toolName !== "phenix_agent" || outcome.handleId !== state.handleId) return;
      if (!outcome.handleStatus || !TERMINAL_HANDLE_STATES.has(outcome.handleStatus)) {
        this.emit({
          boundary: "workflow_gate.delegated",
          sessionId: outcome.sessionId,
          turnId: state.turnId,
          agent: state.agent,
          handleId: state.handleId,
          handleStatus: outcome.handleStatus,
          reason: "handle-still-active",
        });
        return;
      }
      reconcileAuthority(state, "handle-terminal", state.agent);
      return;
    }

    if (state.kind !== "required") return;
    if (outcome.toolName !== "phenix_workflow" || workflowAction(outcome.input) !== "spawn") {
      return;
    }

    const agent = workflowAgent(outcome.input);
    if (
      !outcome.isError &&
      agent &&
      outcome.handleId &&
      (!outcome.handleStatus || !TERMINAL_HANDLE_STATES.has(outcome.handleStatus))
    ) {
      this.stateBySession.set(outcome.sessionId, {
        kind: "delegated",
        turnId: state.turnId,
        userTask: state.userTask,
        requiredAgents: state.requiredAgents,
        agent,
        handleId: outcome.handleId,
      });
      this.emit({
        boundary: "workflow_gate.delegated",
        sessionId: outcome.sessionId,
        turnId: state.turnId,
        agent,
        handleId: outcome.handleId,
        handleStatus: outcome.handleStatus,
        reason: "background-spawn-admitted",
      });
      return;
    }

    reconcileAuthority(state, "spawn-terminal", agent);
  }

  resumeTurn(sessionId: string, turnId: string): void {
    const state = this.stateBySession.get(sessionId);
    if (!state) return;
    this.stateBySession.set(sessionId, { ...state, turnId });
    this.emit({
      boundary: "workflow_gate.resumed",
      sessionId,
      turnId,
      state: state.kind,
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
