from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match in {path}, found {count}\n--- old ---\n{old}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/contract-codec.ts",
    'import { getWorkflowDefinition } from "@matthis-k/phenix-flow/workflow-definitions.ts";\n',
    'import { getWorkflowDefinition } from "@matthis-k/phenix-flow/workflow-definitions.ts";\n'
    'import { initialWorkflowStateForRole } from "@matthis-k/phenix-flow/workflow-runtime.ts";\n',
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/contract-codec.ts",
    "function validateWorkflowSection(raw: unknown, contractId: string): void {",
    "function validateWorkflowSection(\n  raw: unknown,\n  contractId: string,\n  role: AgentRole,\n): void {",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/contract-codec.ts",
    """  const stateExists =
    definition.transitions.some(
      (t) =>
        (t.kind === \"delegate\" && t.from.includes(initialState as never)) ||
        (t.kind === \"automatic\" && t.from === initialState),
    ) || definition.initialState === initialState;
""",
    """  const stateExists =
    definition.transitions.some(
      (t) =>
        (t.kind === \"delegate\" && t.from.includes(initialState as never)) ||
        (t.kind === \"automatic\" && t.from === initialState),
    ) ||
    definition.initialState === initialState ||
    initialWorkflowStateForRole(role) === initialState;
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/contract-codec.ts",
    "  validateWorkflowSection(runtime.workflow, value.id);",
    "  validateWorkflowSection(runtime.workflow, value.id, role);",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/defaults/workflow.ts",
    '    allowedModes: allowedModes ?? ["await"],',
    '    allowedModes: allowedModes ?? (rest.scope === "root" ? ["await", "background"] : ["await"]),',
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-runtime-types.ts",
    """export interface WorkflowHandleResult {
  readonly id: string;
  readonly status: string;
  readonly value?: unknown;
  readonly errors?: readonly string[];
}
""",
    """export interface WorkflowHandleResult {
  readonly id: string;
  readonly subagentId?: string;
  readonly status: string;
  readonly value?: unknown;
  readonly errors?: readonly string[];
}
""",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-api-tools.ts",
    """function compactHandle(record: WorkflowHandleResult): Record<string, unknown> {
  return {
    handleId: record.id,
    status: record.status,
    value: record.value,
    error: record.errors?.join(\" | \"),
    errors: record.errors,
  };
}
""",
    """function compactHandle(record: WorkflowHandleResult): Record<string, unknown> {
  return {
    handleId: record.id,
    subagentId: record.subagentId,
    handle: {
      id: record.id,
      tool: \"phenix_agent\",
      actions: [\"inspect\", \"poll\", \"await\", \"send\", \"cancel\"],
    },
    status: record.status,
    value: record.value,
    error: record.errors?.join(\" | \"),
    errors: record.errors,
  };
}
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-api-tools.ts",
    """  const requirements = normalizeWorkflowRequirements(input.requirements);
  const execution = await input.workflow.spawn({
    agent: input.agent,
    task: input.task,
    ...(input.userTask ? { userTask: input.userTask } : {}),
    ...(requirements && requirements.length > 0 ? { requirements } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.parent ? { parent: input.parent } : {}),
""",
    """  const requirements = normalizeWorkflowRequirements(input.requirements);
  const mode = input.mode ?? (input.parent?.kind === \"child\" ? \"await\" : \"background\");
  const execution = await input.workflow.spawn({
    agent: input.agent,
    task: input.task,
    ...(input.userTask ? { userTask: input.userTask } : {}),
    ...(requirements && requirements.length > 0 ? { requirements } : {}),
    mode,
    ...(input.parent ? { parent: input.parent } : {}),
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-api-tools.ts",
    '      "Inspect current workflow authority or spawn one advertised target agent. " +\n'
    '      "Use this whenever the user explicitly requests workflow delegation or subagents. " +\n',
    '      "Inspect current workflow authority or spawn one advertised target agent. Root spawns default to background mode and return a persistent handle immediately; use phenix_agent to poll, await, steer, or cancel it. " +\n'
    '      "Use this whenever the user explicitly requests workflow delegation or subagents. " +\n',
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-api-tools.ts",
    '      "Spawn the sole legal contract-owned Phenix child directly. The tool is rejected whenever zero or multiple workflow targets are legal. " +\n',
    '      "Spawn the sole legal contract-owned Phenix child directly. Root spawns return a persistent handle immediately by default; use phenix_agent for lifecycle and steering. The tool is rejected whenever zero or multiple workflow targets are legal. " +\n',
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-action-schema.ts",
    """const WorkflowSpawnAction = Type.Object(
""",
    """const WorkflowModeInput = Type.Union([Type.Literal(\"await\"), Type.Literal(\"background\")], {
  description:
    \"Root execution defaults to background and returns a handle immediately. Child-local nested execution defaults to await.\",
});

const WorkflowSpawnAction = Type.Object(
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-action-schema.ts",
    '    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),',
    '    mode: Type.Optional(WorkflowModeInput),',
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/runtime/workflow-action-schema.ts",
    '    mode: Type.Optional(Type.Union([Type.Literal("await"), Type.Literal("background")])),',
    '    mode: Type.Optional(WorkflowModeInput),',
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/delegate-schema.ts",
    """/** Model-facing parameters for one persistent handle operation. */
export const AgentParams = Type.Object(
  {
    action: Type.Union([
      Type.Literal(\"await\"),
      Type.Literal(\"poll\"),
      Type.Literal(\"cancel\"),
      Type.Literal(\"inspect\"),
    ]),
    id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
""",
    """const AgentHandleId = Type.String({ minLength: 1 });

/** Model-facing parameters for one persistent handle operation. */
export const AgentParams = Type.Union([
  Type.Object(
    {
      action: Type.Union([
        Type.Literal(\"await\"),
        Type.Literal(\"poll\"),
        Type.Literal(\"cancel\"),
        Type.Literal(\"inspect\"),
      ]),
      id: AgentHandleId,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal(\"send\"),
      id: AgentHandleId,
      message: Type.String({
        minLength: 1,
        description: \"A concise steering or clarification message for the live child session.\",
      }),
    },
    { additionalProperties: false },
  ),
]);
""",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/facade.ts",
    """  awaitHandle(
    ctx: ExtensionContext,
    id: string,
    signal: AbortSignal,
  ): Promise<SubagentHandleView | undefined>;
  cancelHandle(
""",
    """  awaitHandle(
    ctx: ExtensionContext,
    id: string,
    signal: AbortSignal,
  ): Promise<SubagentHandleView | undefined>;
  sendHandle(
    ctx: ExtensionContext,
    id: string,
    message: string,
    signal: AbortSignal,
  ): Promise<SubagentHandleView | undefined>;
  cancelHandle(
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/facade.ts",
    """    async awaitHandle(ctx, id, signal) {
      return handle(await input.delegator.awaitHandle(ctx, id, signal));
    },
    async cancelHandle(ctx, id, reason) {
""",
    """    async awaitHandle(ctx, id, signal) {
      return handle(await input.delegator.awaitHandle(ctx, id, signal));
    },
    async sendHandle(ctx, id, message, signal) {
      return handle(await input.delegator.sendHandle(ctx, id, message, signal));
    },
    async cancelHandle(ctx, id, reason) {
""",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/workflow-delegator.ts",
    """  async cancelHandle(
    ctx: ExtensionContext,
    id: string,
    reason: string,
  ): Promise<HandleRecord | undefined> {
""",
    """  async sendHandle(
    ctx: ExtensionContext,
    id: string,
    message: string,
    signal: AbortSignal,
  ): Promise<HandleRecord | undefined> {
    return this.delegationRuntime.sendHandle(
      {
        cwd: ctx.cwd,
        sessionId: effectiveSessionId(ctx),
        id,
      },
      message,
      signal,
    );
  }

  async cancelHandle(
    ctx: ExtensionContext,
    id: string,
    reason: string,
  ): Promise<HandleRecord | undefined> {
""",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/managed-delegation-runtime.ts",
    """  async cancelHandle(
    input: ManagedHandleLookup,
    reason: string,
  ): Promise<HandleRecord | undefined> {
""",
    """  async sendHandle(
    input: ManagedHandleLookup,
    message: string,
    signal: AbortSignal,
  ): Promise<HandleRecord | undefined> {
    const record = readRecord(input.cwd, input.sessionId, input.id);
    if (!record) return undefined;
    if (isTerminalHandleStatus(record.status)) {
      throw new SubagentExecutionError(
        \"SUBAGENT_NOT_RUNNING\",
        `Cannot send to terminal Phenix handle ${record.id} (${record.status}).`,
      );
    }
    if (!record.subagentId) {
      throw new SubagentExecutionError(
        \"SUBAGENT_NOT_READY\",
        `Phenix handle ${record.id} has not attached a live child session yet.`,
      );
    }

    const handle = this.managers.get(record.subagentId);
    if (!handle) {
      const orphaned = this.orphan(input.cwd, record);
      throw new SubagentExecutionError(
        \"ORPHANED_SESSION\",
        orphaned.errors?.at(-1) ?? `No live managed subagent exists for handle ${record.id}.`,
      );
    }

    await handle.send(message, signal);
    return readRecord(input.cwd, input.sessionId, input.id) ?? record;
  }

  async cancelHandle(
    input: ManagedHandleLookup,
    reason: string,
  ): Promise<HandleRecord | undefined> {
""",
)

replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/extension.ts",
    'import { AgentParams } from "./delegate-schema.ts";',
    'import { AgentParams, type AgentParamsType } from "./delegate-schema.ts";',
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/extension.ts",
    """    id: record.id,
    handleId: record.id,
    subagentId: record.subagentId,
""",
    """    id: record.id,
    handleId: record.id,
    handle: {
      id: record.id,
      tool: \"phenix_agent\",
      actions: [\"inspect\", \"poll\", \"await\", \"send\", \"cancel\"],
    },
    subagentId: record.subagentId,
""",
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/extension.ts",
    '    description: "Inspect, await, poll, or cancel one known Phenix execution handle.",',
    '    description: "Inspect, poll, await, steer, or cancel one known Phenix execution handle. Use action=send to provide a concise clarification to a live child.",',
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/extension.ts",
    '      const params = rawParams as { action: "await" | "poll" | "cancel" | "inspect"; id: string };',
    '      const params = rawParams as AgentParamsType;',
)
replace_once(
    "modules/phenix-pi/packages/phenix-suite/subagents/extension.ts",
    """      if (params.action === \"poll\")
        return toolResult((await facade.pollHandle(ctx, params.id)) ?? record);
      if (!TERMINAL_STATES.has(record.status)) {
""",
    """      if (params.action === \"poll\")
        return toolResult((await facade.pollHandle(ctx, params.id)) ?? record);
      if (params.action === \"send\") {
        return toolResult(
          (await facade.sendHandle(
            ctx,
            params.id,
            params.message,
            signal ?? new AbortController().signal,
          )) ?? record,
        );
      }
      if (!TERMINAL_STATES.has(record.status)) {
""",
)

replace_once(
    "modules/phenix-pi/skills/phenix-subagents/SKILL.md",
    """`phenix_subagent` is an optional convenience tool. Use it only when the current
workflow node advertises exactly one legal target. It still executes through the
workflow runtime and never bypasses contracts, routing, task ownership, or
verification. Raw `subagent` remains unmanaged and is blocked in Phenix sessions.
""",
    """`phenix_subagent` is an optional convenience tool. Use it only when the current
workflow node advertises exactly one legal target. It still executes through the
workflow runtime and never bypasses contracts, routing, task ownership, or
verification. Raw `subagent` remains unmanaged and is blocked in Phenix sessions.

Root workflow spawns are handle-first: unless `mode: \"await\"` is explicitly
requested, `phenix_workflow` and `phenix_subagent` return immediately with a
persistent `handleId`. Keep that ID and use `phenix_agent` with `inspect`, `poll`,
`await`, `send`, or `cancel`. Use `await` to collect the final structured handoff;
do not spawn a replacement child merely to retrieve an existing result. Use
`send` only for concise clarification or steering while the child is live. Nested
child delegation remains foreground by default because child actors must consume
that handoff before continuing their own contract.
""",
)

replace_once(
    "modules/phenix-pi/tests/workflow-api-tools.test.ts",
    """      requirements: [\"Return concrete evidence.\"],
      signal,
      ctx,
""",
    """      requirements: [\"Return concrete evidence.\"],
      mode: \"background\",
      signal,
      ctx,
""",
)
replace_once(
    "modules/phenix-pi/tests/workflow-api-tools.test.ts",
    """      handleId: \"handle-1\",
      status: \"running\",
""",
    """      handleId: \"handle-1\",
      subagentId: undefined,
      handle: {
        id: \"handle-1\",
        tool: \"phenix_agent\",
        actions: [\"inspect\", \"poll\", \"await\", \"send\", \"cancel\"],
      },
      status: \"running\",
""",
)
replace_once(
    "modules/phenix-pi/tests/workflow-api-tools.test.ts",
    """  it(\"normalizes JSON-encoded requirement arrays from model transports\", async () => {
""",
    """  it(\"defaults child-local workflow execution to await\", async () => {
    const workflow = new RecordingWorkflow();
    const parent = { kind: \"child\" } as never;
    const tool = createWorkflowTool({ workflow, parent });

    await execute(tool, {
      action: \"spawn\",
      agent: \"scout\",
      task: \"Inspect the child boundary.\",
    });

    assert.equal(workflow.spawnCalls[0]?.mode, \"await\");
  });

  it(\"normalizes JSON-encoded requirement arrays from model transports\", async () => {
""",
)
replace_once(
    "modules/phenix-pi/tests/workflow-api-tools.test.ts",
    """    assert.deepEqual(workflow.spawnCalls[0]?.requirements, [\"Return evidence\", \"Do not edit\"]);
""",
    """    assert.deepEqual(workflow.spawnCalls[0]?.requirements, [\"Return evidence\", \"Do not edit\"]);
    assert.equal(workflow.spawnCalls[0]?.mode, \"background\");
""",
)
replace_once(
    "modules/phenix-pi/tests/workflow-api-tools.test.ts",
    """    assert.equal(workflow.spawnCalls[0]?.agent, \"scout\");
    assert.deepEqual(workflow.spawnCalls[0]?.requirements, [\"Return evidence.\"]);
""",
    """    assert.equal(workflow.spawnCalls[0]?.agent, \"scout\");
    assert.deepEqual(workflow.spawnCalls[0]?.requirements, [\"Return evidence.\"]);
    assert.equal(workflow.spawnCalls[0]?.mode, \"background\");
""",
)

(ROOT / "modules/phenix-pi/tests/base-contract-workflow-state.test.ts").write_text(
    '''import assert from "node:assert/strict";
import { describe, it } from "node:test";

import "./support/default-workflow-fixture.ts";
import { decodeContractArtifact } from "@matthis-k/phenix-suite/subagents/contract-codec.ts";
import { createRunId, issueContract } from "@matthis-k/phenix-suite/subagents/contract.ts";
import { rolePreset } from "@matthis-k/phenix-suite/subagents/role-presets.ts";

const preset = rolePreset(null);

describe("base child workflow state", () => {
  it("accepts the role-local executing state even without outgoing transitions", () => {
    const issued = issueContract({
      identity: {
        runId: createRunId(),
        handleId: "base-handle",
        role: null,
      },
      assignment: {
        task: "Complete a bounded non-code task",
        requirements: [],
        outputSchema: { type: "object" },
      },
      runtime: {
        agent: "phenix.base",
        cwd: "/tmp",
        thinking: "medium",
        tools: {
          role: null,
          source: {
            inherited: false,
            patch: { additional: [], removed: [] },
          },
          effective: [...preset.tools],
        },
        skills: [],
        extensions: [],
        delegation: {
          roles: {
            role: null,
            source: {
              inherited: false,
              patch: { additional: [], removed: [] },
            },
            effective: [],
          },
          availableRoles: [],
          remainingDepth: 0,
        },
        workflow: {
          instanceId: "base-instance",
          actorId: "base-actor",
          definitionId: "phenix-default",
          difficulty: "D1",
          initialState: "executing",
          transitionAuthority: { kind: "restricted", allowed: [] },
          capabilityArtifactHash: "0".repeat(64),
        },
        timeoutMs: 60_000,
        turnBudget: {},
        toolBudget: { soft: 10, hard: 20, block: [] },
      },
      verification: {
        commands: [],
        criticRequired: false,
        maxRepairAttempts: 0,
      },
    });

    const decoded = decodeContractArtifact(issued.artifact);
    assert.equal(decoded.runtime.workflow.initialState, "executing");
  });
});
'''
)

print("applied handle-first subagent lifecycle fix")
