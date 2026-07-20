from pathlib import Path
import re

ROOT = Path(".")


def replace_once(path: str, old: str, new: str) -> None:
    file_path = ROOT / path
    text = file_path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}")
    file_path.write_text(text.replace(old, new, 1))


def regex_replace_once(path: str, pattern: str, replacement: str) -> None:
    file_path = ROOT / path
    text = file_path.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}")
    file_path.write_text(updated)


# ---------------------------------------------------------------------------
# Turn gate: represent a successful background spawn as delegated(handleId)
# rather than re-advertising the still-active required transition.
# ---------------------------------------------------------------------------
replace_once(
    "modules/phenix-pi/packages/phenix-suite/composition/workflow-turn-gate.ts",
    """export interface WorkflowToolOutcome extends WorkflowToolInvocation {
  readonly isError: boolean;
  readonly authorityResolved: boolean;
  readonly currentState?: string;
  readonly nextRequiredAgents: readonly string[];
}
""",
    """export interface WorkflowToolOutcome extends WorkflowToolInvocation {
  readonly isError: boolean;
  readonly authorityResolved: boolean;
  readonly currentState?: string;
  readonly nextRequiredAgents: readonly string[];
  readonly handleId?: string;
  readonly handleStatus?: string;
}
""",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/composition/workflow-turn-gate.ts",
    """interface TerminalTurnState {
  readonly kind: \"terminal\";
  readonly turnId: string;
  readonly workflowState: string;
}

type TurnGateState = RequiredTurnState | TerminalTurnState;
""",
    """interface DelegatedTurnState {
  readonly kind: \"delegated\";
  readonly turnId: string;
  readonly userTask: string;
  readonly requiredAgents: readonly string[];
  readonly agent: string;
  readonly handleId: string;
}

interface TerminalTurnState {
  readonly kind: \"terminal\";
  readonly turnId: string;
  readonly workflowState: string;
}

type TurnGateState = RequiredTurnState | DelegatedTurnState | TerminalTurnState;

const TERMINAL_HANDLE_STATES = new Set([\"completed\", \"failed\", \"cancelled\", \"orphaned\"]);
""",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/composition/workflow-turn-gate.ts",
    """function workflowTask(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.task === \"string\" ? input.task.trim() : undefined;
}
""",
    """function workflowTask(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.task === \"string\" ? input.task.trim() : undefined;
}

function handleId(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.id === \"string\" ? input.id : undefined;
}
""",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/composition/workflow-turn-gate.ts",
    """    if (state.kind === \"terminal\") {
      return deny(
        `The Phenix workflow reached terminal state ${JSON.stringify(state.workflowState)} after a failed required delegation. ` +
          \"No further execution is legal in this turn. Report the original workflow failure; a new user turn may retry with a fresh workflow.\",
      );
    }

    const preflightPath = skillReadPath(invocation);
""",
    """    if (state.kind === \"terminal\") {
      return deny(
        `The Phenix workflow reached terminal state ${JSON.stringify(state.workflowState)} after a failed required delegation. ` +
          \"No further execution is legal in this turn. Report the original workflow failure; a new user turn may retry with a fresh workflow.\",
      );
    }

    if (state.kind === \"delegated\") {
      if (invocation.toolName === \"phenix_agent\") {
        const requestedHandle = handleId(invocation.input);
        if (requestedHandle === state.handleId) return undefined;
        return deny(
          `Required delegation is active under handle ${JSON.stringify(state.handleId)}. ` +
            `Use phenix_agent with id=${JSON.stringify(state.handleId)}; do not address a different handle.`,
          state.requiredAgents,
        );
      }
      if (
        invocation.toolName === \"phenix_workflow\" &&
        workflowAction(invocation.input) === \"inspect\"
      ) {
        return undefined;
      }
      return deny(
        `Required delegation is already active under handle ${JSON.stringify(state.handleId)}. ` +
          \"Use phenix_agent with action=inspect, poll, await, send, or cancel to settle that execution before other repository work.\",
        state.requiredAgents,
      );
    }

    const preflightPath = skillReadPath(invocation);
""",
)

observe_replacement = r'''  observe(outcome: WorkflowToolOutcome): void {
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

  clearSession'''
regex_replace_once(
    "modules/phenix-pi/packages/phenix-suite/composition/workflow-turn-gate.ts",
    r"  observe\(outcome: WorkflowToolOutcome\): void \{.*?\n  \}\n\n  clearSession",
    observe_replacement,
)

# ---------------------------------------------------------------------------
# Pi adapter: pass handle lifecycle data to the gate for both spawn and handle
# operations, so terminal await/poll/cancel results reconcile workflow authority.
# ---------------------------------------------------------------------------
regex_replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/extension.ts",
    r'''  pi\.on\("tool_result", async \(event, ctx\) => \{.*?\n  \}\);\n\n  pi\.on\("session_shutdown"''',
    '''  pi.on("tool_result", async (event, ctx) => {
    if (!phenixRootModelScope.includes(ctx.model)) return;
    const isWorkflowSpawn = event.toolName === "phenix_workflow" && event.input.action === "spawn";
    const isHandleLifecycle = event.toolName === "phenix_agent";
    if (!isWorkflowSpawn && !isHandleLifecycle) return;

    const id = sessionId(ctx);
    let isError = event.isError;
    let authorityResolved = false;
    let currentState: string | undefined;
    let nextRequiredAgents: readonly string[] = [];
    try {
      const workflow = facade.workflow.inspect({ ctx }).workflow;
      authorityResolved = true;
      currentState = workflow.currentState;
      nextRequiredAgents = workflow.options
        .filter((option) => option.category === "required")
        .map((option) => option.agent);
    } catch {
      if (!isError) isError = true;
    }

    const rawDetails = (event as { readonly details?: unknown }).details;
    const details =
      typeof rawDetails === "object" && rawDetails !== null && !Array.isArray(rawDetails)
        ? (rawDetails as Readonly<Record<string, unknown>>)
        : {};
    const resultHandleId =
      typeof details.handleId === "string"
        ? details.handleId
        : typeof details.id === "string"
          ? details.id
          : undefined;
    const handleStatus = typeof details.status === "string" ? details.status : undefined;

    options.workflowGate.observe({
      sessionId: id,
      turnId: getSessionRuntime(id).currentTurnId,
      toolName: event.toolName,
      input: event.input,
      isError,
      authorityResolved,
      ...(currentState ? { currentState } : {}),
      nextRequiredAgents,
      ...(resultHandleId ? { handleId: resultHandleId } : {}),
      ...(handleStatus ? { handleStatus } : {}),
    });
  });

  pi.on("session_shutdown"''',
)

# ---------------------------------------------------------------------------
# Workflow vocabulary: base/no-role children are workflow actors too, allowing
# a bounded base task to delegate independent QA concerns to specialist roles.
# ---------------------------------------------------------------------------
replace_once(
    "modules/phenix-pi/packages/phenix-flow/workflow-types.ts",
    """export type WorkflowStateId = string;
""",
    """export type WorkflowStateId = string;

export type WorkflowActorRole = \"base\" | \"coordinator\" | AgentKind;
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-flow/workflow-types.ts",
    '  readonly actorRoles: ReadonlyArray<"coordinator" | AgentKind>;',
    "  readonly actorRoles: readonly WorkflowActorRole[];",
)
replace_once(
    "modules/phenix-pi/packages/phenix-flow/workflow-types.ts",
    'export function actorRoleForAgentClient(ref: AgentClientRef): "base" | "coordinator" | AgentKind {',
    "export function actorRoleForAgentClient(ref: AgentClientRef): WorkflowActorRole {",
)
replace_once(
    "modules/phenix-pi/packages/phenix-flow/workflow-types.ts",
    '  readonly actorRole: "coordinator" | AgentKind | "base";',
    "  readonly actorRole: WorkflowActorRole;",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    """  WorkflowOutputSchemaId,
  WorkflowStateId,
  WorkflowTransition,
""",
    """  WorkflowActorRole,
  WorkflowOutputSchemaId,
  WorkflowStateId,
  WorkflowTransition,
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    '  readonly actorRoles: ReadonlyArray<"coordinator" | AgentKind>;',
    "  readonly actorRoles: readonly WorkflowActorRole[];",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    """const COORDINATOR: ReadonlyArray<\"coordinator\" | AgentKind> = [\"coordinator\"];
const PLANNER: ReadonlyArray<\"coordinator\" | AgentKind> = [\"planner\"];
const ARCHITECT: ReadonlyArray<\"coordinator\" | AgentKind> = [\"architect\"];
const IMPLEMENTER: ReadonlyArray<\"coordinator\" | AgentKind> = [\"implementer\"];
const TESTER: ReadonlyArray<\"coordinator\" | AgentKind> = [\"tester\"];
const CRITIC: ReadonlyArray<\"coordinator\" | AgentKind> = [\"critic\"];
const FINALIZER: ReadonlyArray<\"coordinator\" | AgentKind> = [\"finalizer\"];
const SCOUT: ReadonlyArray<\"coordinator\" | AgentKind> = [\"scout\"];
""",
    """const COORDINATOR: readonly WorkflowActorRole[] = [\"coordinator\"];
const BASE: readonly WorkflowActorRole[] = [\"base\"];
const PLANNER: readonly WorkflowActorRole[] = [\"planner\"];
const ARCHITECT: readonly WorkflowActorRole[] = [\"architect\"];
const IMPLEMENTER: readonly WorkflowActorRole[] = [\"implementer\"];
const TESTER: readonly WorkflowActorRole[] = [\"tester\"];
const CRITIC: readonly WorkflowActorRole[] = [\"critic\"];
const FINALIZER: readonly WorkflowActorRole[] = [\"finalizer\"];
const SCOUT: readonly WorkflowActorRole[] = [\"scout\"];
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    '  readonly actorRoles: ReadonlyArray<"coordinator" | AgentKind>;',
    "  readonly actorRoles: readonly WorkflowActorRole[];",
)

base_nested = '''// Base/no-role nested children for concern-isolated analysis
nestedDelegate({
  id: "base.request-scout",
  actorRoles: BASE,
  from: "executing",
  role: "scout",
  purpose: "nested-evidence",
  description: "Base agent delegates repository topology and evidence discovery",
  outputSchemaId: "scout-handoff",
});
nestedDelegate({
  id: "base.request-tester",
  actorRoles: BASE,
  from: "executing",
  role: "tester",
  purpose: "nested-testing",
  description: "Base agent delegates deterministic QA runtime, code metrics, and verification",
  outputSchemaId: "test-handoff",
});
nestedDelegate({
  id: "base.request-architect",
  actorRoles: BASE,
  from: "executing",
  role: "architect",
  purpose: "nested-review",
  description: "Base agent delegates architecture and dependency-boundary analysis",
  outputSchemaId: "architecture-handoff",
});
nestedDelegate({
  id: "base.request-critic",
  actorRoles: BASE,
  from: "executing",
  role: "critic",
  purpose: "nested-review",
  description: "Base agent delegates readability, patterns, system, operability, and security review",
  outputSchemaId: "critic-handoff",
});

'''
replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    "// Planner nested children\n",
    base_nested + "// Planner nested children\n",
)

# ---------------------------------------------------------------------------
# Regression coverage.
# ---------------------------------------------------------------------------
workflow_gate_test = '''
  it("allows lifecycle operations for the active required-delegation handle", () => {
    const gate = createWorkflowTurnGate();
    gate.beginTurn({
      sessionId,
      turnId,
      userTask: "Do a full QA for this repo.",
      requiredAgents: ["base"],
    });

    gate.observe({
      ...invocation("phenix_workflow", {
        action: "spawn",
        agent: "base",
        task: "Run the repository QA review.",
      }),
      isError: false,
      authorityResolved: true,
      currentState: "classified",
      nextRequiredAgents: ["base"],
      handleId: "handle-qa",
      handleStatus: "running",
    });

    assert.equal(
      gate.authorize(invocation("phenix_agent", { action: "poll", id: "handle-qa" })),
      undefined,
    );
    assert.equal(
      gate.authorize(invocation("phenix_agent", { action: "await", id: "handle-qa" })),
      undefined,
    );
    assert.match(
      gate.authorize(invocation("phenix_agent", { action: "poll", id: "other-handle" })) ?? "",
      /handle-qa/i,
    );
    assert.match(gate.authorize(invocation("read", { path: "src/index.ts" })) ?? "", /active/i);

    gate.observe({
      ...invocation("phenix_agent", { action: "await", id: "handle-qa" }),
      isError: false,
      authorityResolved: true,
      currentState: "completed",
      nextRequiredAgents: [],
      handleId: "handle-qa",
      handleStatus: "completed",
    });

    assert.equal(gate.authorize(invocation("read", { path: "src/index.ts" })), undefined);
  });

'''
replace_once(
    "modules/phenix-pi/tests/workflow-turn-gate.test.ts",
    '  it("reconciles a failed workflow node instead of advertising stale agents", () => {\n',
    workflow_gate_test
    + '  it("reconciles a failed workflow node instead of advertising stale agents", () => {\n',
)

workflow_definition_test = '''
  it("allows a base child to isolate QA concerns in specialist subsessions", () => {
    const expected = [
      ["base.request-scout", "scout"],
      ["base.request-tester", "tester"],
      ["base.request-architect", "architect"],
      ["base.request-critic", "critic"],
    ] as const;

    for (const [id, role] of expected) {
      const transition = PHENIX_DEFAULT_WORKFLOW.transitions.find((candidate) => candidate.id === id);
      assert.ok(transition, `${id} exists`);
      assert.equal(transition.kind, "delegate");
      if (transition.kind === "delegate") {
        assert.equal(transition.scope, "child");
        assert.ok(transition.actorRoles.includes("base"));
        assert.equal(transition.agentClient.id, role);
        assert.ok(transition.from.includes("executing"));
      }
    }
  });

'''
replace_once(
    "modules/phenix-pi/tests/workflow-definitions.test.ts",
    '  it("has child-local nested transitions", () => {\n',
    workflow_definition_test + '  it("has child-local nested transitions", () => {\n',
)

# ---------------------------------------------------------------------------
# QA skill: make the base child an integrator and isolate review concerns.
# ---------------------------------------------------------------------------
qa_fanout = '''## Required subsession decomposition for full QA

For a full repository or module QA, the base child is the **review integrator**, not the sole reviewer. Keep unrelated evidence and judgment in separate child contexts. When the corresponding child targets are advertised, delegate these bounded concerns individually:

1. **Scout** — repository topology, module boundaries, test inventory, hotspots, and evidence locations.
2. **Tester** — deterministic QA runtime, project-native checks, code metrics, structural analysis, analyzer coverage, and reproducible command results.
3. **Architect** — dependency direction, facade/implementation boundaries, cohesion, state-machine design, and cross-module coupling.
4. **Critic** — readability, pattern consistency, system integration, operability, security, and challenge of provisional findings.

Use one `phenix_workflow` child execution per concern. Child-local specialist transitions are foreground: collect each handoff before composing the next dependent review. Do not duplicate the same concern in multiple children unless a critic is explicitly challenging another handoff.

The root coordinator must spawn the required base transition only once. A background root spawn returns a handle; while it is active, use `phenix_agent` with that exact handle for `inspect`, `poll`, `await`, `send`, or `cancel`. Never retry the same required transition merely because collection is still in progress.

The base integrator must merge specialist handoffs into the runtime-backed QA contribution, preserve evidence IDs, distinguish unavailable analyzers from clean results, and let the QA runtime calculate gates and risk scores.

'''
replace_once(
    "modules/phenix-pi/skills/phenix-qa/SKILL.md",
    "## Implemented runtime capability\n",
    qa_fanout + "## Implemented runtime capability\n",
)
