from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def update(path: str, replacements: list[tuple[str, str]]) -> None:
    target = ROOT / path
    content = target.read_text()
    for old, new in replacements:
        count = content.count(old)
        if count != 1:
            raise RuntimeError(f"{path}: expected one match, found {count}: {old[:100]!r}")
        content = content.replace(old, new, 1)
    target.write_text(content)


update(
    "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts",
    [
        (
            'import type { AgentRole } from "../phenix-kernel/agents.ts";\n',
            'import type { AgentRole } from "../phenix-kernel/agents.ts";\n'
            'import { modelSetId } from "../phenix-kernel/ids.ts";\n'
            'import { agentClientRef } from "../phenix-kernel/refs.ts";\n',
        ),
        (
            'import { ChildRuntimeError, childRunId } from "../phenix-runtime/child-session-types.ts";\n',
            'import {\n'
            '  ChildRuntimeError,\n'
            '  childRunId,\n'
            '  isChildRuntimeErrorCode,\n'
            '} from "../phenix-runtime/child-session-types.ts";\n',
        ),
        (
            'import {\n  finalizeHandleWorkflow,\n  initialWorkflowStateForRole,\n  transitionAuthorityForChild,\n} from "../phenix-workflow/workflow-runtime.ts";\n',
            'import {\n  finalizeHandleWorkflow,\n  initialWorkflowStateForRole,\n  transitionAuthorityForChild,\n} from "../phenix-workflow/workflow-runtime.ts";\n'
            'import type { WorkflowActorSource } from "../phenix-workflow/workflow-runtime.ts";\n',
        ),
        (
            '    const source =\n      parent.kind === "child"\n        ? { kind: "child" as const, contract: parent.contract }\n        : { kind: "root" as const, sessionId };\n',
            '    const source: WorkflowActorSource =\n      parent.kind === "child"\n        ? { kind: "child", contract: parent.contract }\n        : { kind: "root", sessionId };\n',
        ),
        ('      source: source as any,\n', '      source,\n'),
        ('            handle: handle as any,\n', '            handle,\n'),
        ('          modelSet: selectedModelSet as any,\n', '          modelSet: modelSetId(selectedModelSet),\n'),
        (
            '        agentClient: {\n          id: producerSpec.agent.replace("phenix.", "") as any,\n          kind: "agent" as any,\n        },\n',
            '        agentClient: agentClientRef(producerSpec.agent.replace(/^phenix\\./, "")),\n',
        ),
        ('      modelSet: input.record.modelSet as any,\n', '      modelSet: modelSetId(input.record.modelSet),\n'),
        (
            '      agentClient: {\n        id: criticSpec.agent.replace("phenix.", "") as any,\n        kind: "agent" as any,\n      },\n',
            '      agentClient: agentClientRef(criticSpec.agent.replace(/^phenix\\./, "")),\n',
        ),
        (
            '        throw new ChildRuntimeError(\n          (outcome.error?.code ??\n            (outcome.status === "cancelled" ? "ABORTED" : "PROVIDER_FAILED")) as any,\n          outcome.error?.message ?? "Critic session did not settle successfully.",\n        );\n',
            '        const code =\n          outcome.status === "cancelled"\n            ? "ABORTED"\n            : isChildRuntimeErrorCode(outcome.error?.code)\n              ? outcome.error.code\n              : "PROVIDER_FAILED";\n        throw new ChildRuntimeError(\n          code,\n          outcome.error?.message ?? "Critic session did not settle successfully.",\n        );\n',
        ),
        (
            '          `${run.id}: ${run.status}` + (run.exitCode === null ? "" : ` (exit ${run.exitCode})`),\n',
            '          `${run.id}: ${run.status}${run.exitCode === null ? "" : ` (exit ${run.exitCode})`}`,\n',
        ),
    ],
)

update(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-types.ts",
    [
        (
            '  | "ORPHANED_SESSION";\n\nexport class ChildRuntimeError extends Error {\n',
            '  | "ORPHANED_SESSION";\n\n'
            'const CHILD_RUNTIME_ERROR_CODES: ReadonlySet<string> = new Set([\n'
            '  "MODEL_NOT_FOUND",\n'
            '  "MODEL_AUTH_UNAVAILABLE",\n'
            '  "SESSION_START_FAILED",\n'
            '  "PROMPT_REJECTED",\n'
            '  "PROVIDER_FAILED",\n'
            '  "CONTRACT_NOT_SUBMITTED",\n'
            '  "CONTRACT_INVALID",\n'
            '  "TURN_BUDGET_EXCEEDED",\n'
            '  "TOOL_BUDGET_EXCEEDED",\n'
            '  "TIMEOUT",\n'
            '  "ABORTED",\n'
            '  "VERIFICATION_FAILED",\n'
            '  "CRITIC_REJECTED",\n'
            '  "REPAIR_LIMIT_EXCEEDED",\n'
            '  "RPC_PROCESS_EXITED",\n'
            '  "RPC_NESTED_DELEGATION_UNSUPPORTED",\n'
            '  "RPC_CONTRACT_RUNTIME_UNAVAILABLE",\n'
            '  "ORPHANED_SESSION",\n'
            ']);\n\n'
            '/** Narrow a serialized provider/runtime code before constructing a typed error. */\n'
            'export function isChildRuntimeErrorCode(value: unknown): value is ChildRuntimeErrorCode {\n'
            '  return typeof value === "string" && CHILD_RUNTIME_ERROR_CODES.has(value);\n'
            '}\n\n'
            'export class ChildRuntimeError extends Error {\n',
        ),
    ],
)

update(
    "modules/phenix-pi/extensions/phenix-workflow/workflow-runtime.ts",
    [
        (
            '  if (!transition || transition.kind !== "delegate") {\n',
            '  if (transition?.kind !== "delegate") {\n',
        ),
    ],
)

update(
    "modules/phenix-pi/extensions/phenix.ts",
    [
        ('import { fileURLToPath } from "node:url";\n', ''),
        (
            'import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";\n',
            'import type { ExtensionAPI, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";\n',
        ),
        ('import { PHENIX_PROVIDER } from "./phenix-routing/provider.ts";\n', ''),
        (
            '      return [\n        createDelegationTool({\n          coordinator,\n          parent: spec.parentContext,\n          decisionContext: spec.workflowProjection,\n        }) as any,\n      ];\n',
            '      const delegationTool = createDelegationTool({\n        coordinator,\n        parent: spec.parentContext,\n        decisionContext: spec.workflowProjection,\n      });\n\n'
            '      // The runtime tool is structurally compatible with Pi. Keep this\n'
            '      // conversion at the composition boundary rather than in domain code.\n'
            '      return [delegationTool as unknown as ToolDefinition];\n',
        ),
    ],
)
