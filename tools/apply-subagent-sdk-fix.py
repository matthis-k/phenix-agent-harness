from __future__ import annotations

from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


sdk = "modules/phenix-pi/packages/phenix-suite/runtime/sdk-child-session-backend.ts"
replace(
    sdk,
    '  type ModelRegistry,\n  SessionManager,',
    '  type ModelRegistry,\n  type ModelRuntime,\n  SessionManager,',
)
replace(sdk, '  readonly modelRegistry: ModelRegistry;\n', '  readonly modelRuntime: ModelRuntime;\n')
replace(sdk, '      modelRegistry: spec.modelRegistry,\n', '      modelRuntime: spec.modelRuntime,\n')
marker = "// ── PiSessionLike — injectable session interface for testing ────────────────\n"
helper = '''function modelRuntimeFromRegistry(registry: ModelRegistry): ModelRuntime {
  const runtime = (registry as unknown as { readonly runtime?: ModelRuntime }).runtime;
  if (!runtime) {
    throw new ChildRuntimeError(
      "SESSION_START_FAILED",
      "The active Pi model runtime is unavailable to the child-session adapter.",
    );
  }
  return runtime;
}

'''
replace(sdk, marker, helper + marker)
replace(
    sdk,
    '      modelRegistry,\n      agentDir: this.services.agentDir,',
    '      modelRuntime: modelRuntimeFromRegistry(modelRegistry),\n      agentDir: this.services.agentDir,',
)
file = Path(sdk)
text = file.read_text()
start_marker = '      (error) => {\n  const providerMessage = this.lastProviderFailure?.message;'
if start_marker in text:
    start = text.index(start_marker)
    end = text.index('},\n    );', start) + len('},')
    replacement = '''      (error) => {
        const providerMessage = this.lastProviderFailure?.message;
        const message = providerMessage ?? (error instanceof Error ? error.message : String(error));
        const providerError = new ChildRuntimeError("PROVIDER_FAILED", message, {
          cause: error,
        });
        if (!preflightSeen) reject(providerError);
        void this.failAndAbort(providerError);
      },'''
    file.write_text(text[:start] + replacement + text[end:])

schema = "modules/phenix-pi/packages/phenix-suite/runtime/workflow-action-schema.ts"
replace(
    schema,
    '  if (Array.isArray(value)) return normalize(value);\n\n  const encoded = value.trim();',
    '  if (typeof value !== "string") return normalize(value);\n\n  const encoded = value.trim();',
)

normalizer = "modules/phenix-pi/packages/phenix-suite/runtime/session-event-normalizer.ts"
replace(
    normalizer,
    '''import type {
  ChildRunId,
  ChildSessionEvent,
  SerializedError,
} from "./child-session-types.ts";
''',
    'import type { ChildRunId, ChildSessionEvent, SerializedError } from "./child-session-types.ts";\n',
)

workflow_tools = "modules/phenix-pi/packages/phenix-suite/runtime/workflow-api-tools.ts"
file = Path(workflow_tools)
text = file.read_text()
old = '''function errorResult(
  message: string,
  details?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: details ?? { status: "failed" },
  };
}
'''
new = '''export class WorkflowToolError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkflowToolError";
    this.details = details ?? { status: "failed" };
  }
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new WorkflowToolError(message, details);
}
'''
if old not in text:
    raise SystemExit("workflow error result block not found")
text = text.replace(old, new, 1).replace("errorResult(", "fail(")
text = text.replace(
    '} catch (error) {\n        return fail(error instanceof Error ? error.message : String(error));\n      }',
    '} catch (error) {\n        if (error instanceof WorkflowToolError) throw error;\n        return fail(error instanceof Error ? error.message : String(error));\n      }',
)
text = text.replace(
    'export type WorkflowApiToolName =\n  | typeof PHENIX_WORKFLOW_TOOL\n  | typeof PHENIX_SUBAGENT_TOOL;',
    'export type WorkflowApiToolName = typeof PHENIX_WORKFLOW_TOOL | typeof PHENIX_SUBAGENT_TOOL;',
)
text = text.replace(
    '''          ...(params.requirements !== undefined
            ? { requirements: params.requirements }
            : {}),''',
    '          ...(params.requirements !== undefined ? { requirements: params.requirements } : {}),',
)
text = text.replace(
    '        if (!authority.effectiveTools.includes(PHENIX_SUBAGENT_TOOL)) {\n          return fail(\n            "Direct Phenix subagent creation is not authorized for the current workflow node. Use phenix_workflow with action=spawn and one advertised target agent.",',
    '        if (availableAgents.length !== 1) {\n          return fail(\n            "Direct Phenix subagent creation is available only when the current workflow node has exactly one legal target. Use phenix_workflow otherwise.",',
)
text = text.replace(
    '              code: "DIRECT_SUBAGENT_NOT_AUTHORIZED",\n              availableAgents,',
    '              code: "DIRECT_SUBAGENT_NOT_DETERMINISTIC",\n              availableAgents,',
)
text = text.replace(
    '        const agent =\n          params.agent ?? (availableAgents.length === 1 ? availableAgents[0] : undefined);',
    '        const agent = params.agent ?? availableAgents[0];',
)
text = text.replace(
    '              "Direct subagent creation requires an agent because multiple targets are currently available.",',
    '              "Direct subagent creation could not resolve the sole legal target.",',
)
text = text.replace(
    '              code: "DIRECT_SUBAGENT_AGENT_REQUIRED",',
    '              code: "DIRECT_SUBAGENT_TARGET_MISSING",',
)
text = text.replace(
    '      "Spawn a contract-owned Phenix child directly when the current authority explicitly enables phenix_subagent. " +\n      "Normally use phenix_workflow instead. This tool never bypasses workflow contracts, routing, task-subtree ownership, or verification.",',
    '      "Spawn the sole legal contract-owned Phenix child directly. The tool is rejected whenever zero or multiple workflow targets are legal. " +\n      "Normally use phenix_workflow instead. This tool never bypasses workflow contracts, routing, task-subtree ownership, or verification.",',
)
file.write_text(text)

subagents = "modules/phenix-pi/packages/phenix-suite/subagents/extension.ts"
replace(
    subagents,
    '''function errorResult(
  message: string,
  details?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    details: details ?? { status: "failed" },
  };
}
''',
    '''function errorResult(message: string, details?: Record<string, unknown>): never {
  const error = new Error(message) as Error & { details?: Record<string, unknown> };
  error.details = details ?? { status: "failed" };
  throw error;
}
''',
)

policy = "modules/phenix-pi/packages/phenix-suite/subagents/tool-policy.ts"
replace(
    policy,
    'const RUNTIME_TOOLS = new Set(["subagent", "phenix_complete", "phenix_tasks", "phenix_workflow"]);',
    'const RUNTIME_TOOLS = new Set([\n  "subagent",\n  "phenix_complete",\n  "phenix_subagent",\n  "phenix_tasks",\n  "phenix_workflow",\n]);',
)

replace(
    sdk,
    '  const runtimeTools = new Set(["subagent", "phenix_complete", "phenix_tasks", "phenix_workflow"]);\n  const baseTools = spec.effectiveTools.filter((tool) => !runtimeTools.has(tool));\n\n  return [...new Set([...baseTools, "phenix_complete", "phenix_tasks", "phenix_workflow"])].sort();',
    '  const runtimeTools = new Set([\n    "subagent",\n    "phenix_complete",\n    "phenix_subagent",\n    "phenix_tasks",\n    "phenix_workflow",\n  ]);\n  const baseTools = spec.effectiveTools.filter((tool) => !runtimeTools.has(tool));\n  const directSubagent = spec.workflowProjection.options.length === 1 ? ["phenix_subagent"] : [];\n\n  return [\n    ...new Set([\n      ...baseTools,\n      "phenix_complete",\n      ...directSubagent,\n      "phenix_tasks",\n      "phenix_workflow",\n    ]),\n  ].sort();',
)

tasks = "modules/phenix-pi/packages/phenix-suite/tasks/suite-integration.ts"
replace(
    tasks,
    '''  const owner =
    task.completedBySessionId ?? task.startedBySessionId ?? task.assignedSessionId;''',
    '  const owner = task.completedBySessionId ?? task.startedBySessionId ?? task.assignedSessionId;',
)
replace(
    tasks,
    '''  const visit = (
    task: TaskNode,
    prefix: string,
    connector: "" | "├─ " | "└─ ",
  ): void => {''',
    '  const visit = (task: TaskNode, prefix: string, connector: "" | "├─ " | "└─ "): void => {',
)

sdk_test = "modules/phenix-pi/tests/sdk-child-session-backend.test.ts"
file = Path(sdk_test)
text = file.read_text()
text = text.replace(
    '''import type {
  AgentSessionEvent,
  DefaultResourceLoader,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  type PiSessionFactory,
  type PiSessionLike,
  type PreparedPiSessionSpec,
  SdkChildSessionBackend,
} from "@matthis-k/phenix-suite/runtime/sdk-child-session-backend.ts";
import {
  type ChildSessionSpec,
  childRunId,
} from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
''',
    '''import type {
  AgentSessionEvent,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  type ChildSessionSpec,
  childRunId,
} from "@matthis-k/phenix-suite/runtime/child-session-types.ts";
import {
  type PiSessionFactory,
  type PiSessionLike,
  type PreparedPiSessionSpec,
  SdkChildSessionBackend,
} from "@matthis-k/phenix-suite/runtime/sdk-child-session-backend.ts";
''',
)
text = text.replace(
    '  it("passes the captured root model registry into the child Pi session", async () => {\n    const concreteModel',
    '  it("passes the captured root model runtime into the child Pi session", async () => {\n    const concreteModel',
)
text = text.replace(
    '    const registry = {\n      find(provider: string, id: string) {',
    '    const modelRuntime = {} as ModelRuntime;\n    const registry = {\n      runtime: modelRuntime,\n      find(provider: string, id: string) {',
    1,
)
text = text.replace('    assert.equal(factory.spec?.modelRegistry, registry);', '    assert.equal(factory.spec?.modelRuntime, modelRuntime);')
second = '''    const registry = {
      find() {
        return { provider: "test-provider", id: "test-model" };
      },
    } as unknown as ModelRegistry;'''
second_new = '''    const registry = {
      runtime: {} as ModelRuntime,
      find() {
        return { provider: "test-provider", id: "test-model" };
      },
    } as unknown as ModelRegistry;'''
if second not in text:
    raise SystemExit("second SDK registry fixture not found")
file.write_text(text.replace(second, second_new, 1))

workflow_test = "modules/phenix-pi/tests/workflow-api-tools.test.ts"
file = Path(workflow_test)
text = file.read_text()
text = text.replace(
    '  projectWorkflowInspection,\n} from "@matthis-k/phenix-suite/runtime/workflow-api-tools.ts";',
    '  projectWorkflowInspection,\n  WorkflowToolError,\n} from "@matthis-k/phenix-suite/runtime/workflow-api-tools.ts";',
)
helper_marker = '''async function execute(
  tool: ReturnType<typeof createWorkflowTool> | ReturnType<typeof createDirectSubagentTool>,
  params: Record<string, unknown>,
  signal = new AbortController().signal,
) {
  return tool.execute("call-1", params as never, signal, undefined, ctx);
}
'''
helper_new = helper_marker + '''
async function assertToolFailure(
  promise: Promise<unknown>,
  expectedDetails: Record<string, unknown>,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkflowToolError);
    assert.deepEqual(error.details, expectedDetails);
    return true;
  });
}
'''
if helper_marker not in text:
    raise SystemExit("workflow execute helper not found")
text = text.replace(helper_marker, helper_new, 1)
old = '''    const response = await execute(tool, {
      action: "spawn",
      agent: "scout",
      task: "Inspect something.",
    });

    assert.equal(workflow.spawnCalls.length, 0);
    assert.equal(response.isError, true);
    assert.deepEqual(response.details, {
      status: "forbidden",
      tool: "phenix_workflow",
    });'''
new = '''    await assertToolFailure(
      execute(tool, {
        action: "spawn",
        agent: "scout",
        task: "Inspect something.",
      }),
      { status: "forbidden", tool: "phenix_workflow" },
    );

    assert.equal(workflow.spawnCalls.length, 0);'''
if old not in text:
    raise SystemExit("authorization test block not found")
text = text.replace(old, new, 1)
old = '''    const response = await execute(tool, {
      action: "spawn",
      agent: "scout",
      task: "Inspect something.",
    });

    assert.equal(workflow.spawnCalls.length, 1);
    assert.equal(response.isError, true);
    assert.equal(response.details?.code, "WORKFLOW_AGENT_NOT_AVAILABLE");
    assert.equal(response.details?.currentNodeId, "reviewing");'''
new = '''    await assertToolFailure(
      execute(tool, {
        action: "spawn",
        agent: "scout",
        task: "Inspect something.",
      }),
      {
        code: "WORKFLOW_AGENT_NOT_AVAILABLE",
        currentNodeId: "reviewing",
      },
    );

    assert.equal(workflow.spawnCalls.length, 1);'''
if old not in text:
    raise SystemExit("backend failure test block not found")
text = text.replace(old, new, 1)
old = '''    const response = await execute(tool, { task: "Inspect directly." });

    assert.equal(workflow.spawnCalls.length, 0);
    assert.equal(response.isError, true);
    assert.equal(response.details?.code, "DIRECT_SUBAGENT_NOT_AUTHORIZED");
    assert.deepEqual(response.details?.availableAgents, ["scout"]);'''
new = '''    workflow.authority = {
      ...workflow.authority,
      workflow: { ...workflow.authority.workflow, options: [] },
    };
    await assertToolFailure(execute(tool, { task: "Inspect directly." }), {
      code: "DIRECT_SUBAGENT_NOT_DETERMINISTIC",
      availableAgents: [],
    });

    assert.equal(workflow.spawnCalls.length, 0);'''
if old not in text:
    raise SystemExit("direct denial test block not found")
text = text.replace(old, new, 1)
text = text.replace('    assert.equal(response.isError, undefined);\n', '')
text = text.replace(
    '''    assert.deepEqual(workflow.spawnCalls[0]?.requirements, [
      "Return evidence",
      "Do not edit",
    ]);''',
    '    assert.deepEqual(workflow.spawnCalls[0]?.requirements, ["Return evidence", "Do not edit"]);',
)
text = text.replace(
    '''    workflow.authority = {
      ...workflow.authority,
      effectiveTools: [...workflow.authority.effectiveTools, "phenix_subagent"],
    };
''',
    '',
)
file.write_text(text)

bootstrap_test = "modules/phenix-pi/tests/phenix-skill-bootstrap.test.ts"
replace(
    bootstrap_test,
    '    assert.match(bootstrapped, /mandatory initial\\s+authority inspection/i);',
    '    assert.match(bootstrapped, /first substantive\\s+execution action/i);\n    assert.match(bootstrapped, /phenix_subagent/);',
)

skill = "modules/phenix-pi/skills/phenix-subagents/SKILL.md"
file = Path(skill)
text = file.read_text().replace(
    '`phenix_subagent` is an optional convenience tool. Use it only when the current\nauthority explicitly lists it in `effectiveTools`. It still executes through the',
    '`phenix_subagent` is an optional convenience tool. Use it only when the current\nworkflow node advertises exactly one legal target. It still executes through the',
)
file.write_text(text)
