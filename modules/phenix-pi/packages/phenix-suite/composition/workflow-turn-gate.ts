export interface WorkflowTurnRequirement {
  readonly sessionId: string;
  readonly turnId: string;
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
  readonly nextRequiredAgents: readonly string[];
}

export interface WorkflowTurnGate {
  beginTurn(requirement: WorkflowTurnRequirement): void;
  authorize(invocation: WorkflowToolInvocation): string | undefined;
  observe(outcome: WorkflowToolOutcome): void;
  clearSession(sessionId: string): void;
}

export type WorkflowTurnGateTrace = (record: Readonly<Record<string, unknown>>) => void;

interface PendingRequirement {
  readonly turnId: string;
  readonly requiredAgents: readonly string[];
}

function uniqueAgents(agents: readonly string[]): readonly string[] {
  return [...new Set(agents.map((agent) => agent.trim()).filter(Boolean))].sort();
}

function workflowAction(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.action === "string" ? input.action : undefined;
}

function workflowAgent(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.agent === "string" ? input.agent : undefined;
}

class WorkflowTurnGateImpl implements WorkflowTurnGate {
  private readonly pendingBySession = new Map<string, PendingRequirement>();

  constructor(private readonly trace?: WorkflowTurnGateTrace) {}

  beginTurn(requirement: WorkflowTurnRequirement): void {
    const requiredAgents = uniqueAgents(requirement.requiredAgents);
    if (requiredAgents.length === 0) {
      this.pendingBySession.delete(requirement.sessionId);
      this.trace?.({
        boundary: "workflow_gate.open",
        sessionId: requirement.sessionId,
        turnId: requirement.turnId,
        reason: "no-required-transition",
      });
      return;
    }

    this.pendingBySession.set(requirement.sessionId, {
      turnId: requirement.turnId,
      requiredAgents,
    });
    this.trace?.({
      boundary: "workflow_gate.required",
      sessionId: requirement.sessionId,
      turnId: requirement.turnId,
      requiredAgents,
    });
  }

  authorize(invocation: WorkflowToolInvocation): string | undefined {
    const pending = this.pendingBySession.get(invocation.sessionId);
    if (!pending) return undefined;
    if (invocation.turnId !== pending.turnId) {
      this.pendingBySession.delete(invocation.sessionId);
      return undefined;
    }

    const deny = (reason: string): string => {
      this.trace?.({
        boundary: "workflow_gate.blocked",
        sessionId: invocation.sessionId,
        turnId: pending.turnId,
        toolName: invocation.toolName,
        requiredAgents: pending.requiredAgents,
        reason,
      });
      return reason;
    };

    if (invocation.toolName !== "phenix_workflow") {
      return deny(
        `The current Phenix workflow requires delegation before ${invocation.toolName}. ` +
          `Call phenix_workflow with action=spawn and one of: ${pending.requiredAgents.join(", ")}.`,
      );
    }

    const action = workflowAction(invocation.input);
    if (action !== "spawn") {
      return deny(
        `The current Phenix workflow requires action=spawn before other execution. ` +
          `Choose one of: ${pending.requiredAgents.join(", ")}.`,
      );
    }

    const agent = workflowAgent(invocation.input);
    if (!agent || !pending.requiredAgents.includes(agent)) {
      return deny(
        `Agent ${agent ? JSON.stringify(agent) : "<missing>"} is not a currently required target. ` +
          `Choose one of: ${pending.requiredAgents.join(", ")}.`,
      );
    }

    this.trace?.({
      boundary: "workflow_gate.admitted",
      sessionId: invocation.sessionId,
      turnId: pending.turnId,
      toolName: invocation.toolName,
      agent,
    });
    return undefined;
  }

  observe(outcome: WorkflowToolOutcome): void {
    const pending = this.pendingBySession.get(outcome.sessionId);
    if (!pending || outcome.turnId !== pending.turnId) return;
    if (outcome.toolName !== "phenix_workflow" || workflowAction(outcome.input) !== "spawn") {
      return;
    }

    if (outcome.isError) {
      this.trace?.({
        boundary: "workflow_gate.failed",
        sessionId: outcome.sessionId,
        turnId: pending.turnId,
        agent: workflowAgent(outcome.input),
        requiredAgents: pending.requiredAgents,
      });
      return;
    }

    const nextRequiredAgents = uniqueAgents(outcome.nextRequiredAgents);
    if (nextRequiredAgents.length > 0) {
      this.pendingBySession.set(outcome.sessionId, {
        turnId: pending.turnId,
        requiredAgents: nextRequiredAgents,
      });
      this.trace?.({
        boundary: "workflow_gate.required",
        sessionId: outcome.sessionId,
        turnId: pending.turnId,
        requiredAgents: nextRequiredAgents,
        reason: "authority-advanced",
      });
      return;
    }

    this.pendingBySession.delete(outcome.sessionId);
    this.trace?.({
      boundary: "workflow_gate.fulfilled",
      sessionId: outcome.sessionId,
      turnId: pending.turnId,
      agent: workflowAgent(outcome.input),
    });
  }

  clearSession(sessionId: string): void {
    this.pendingBySession.delete(sessionId);
  }
}

export function createWorkflowTurnGate(input: {
  readonly trace?: WorkflowTurnGateTrace;
} = {}): WorkflowTurnGate {
  return new WorkflowTurnGateImpl(input.trace);
}
