from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match in {path}, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new))


coordinator = "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts"
phenix = "modules/phenix-pi/extensions/phenix.ts"

replace_once(
    coordinator,
    'import { ContractSubmissionChannelImpl } from "../phenix-runtime/contract-channel.ts";\n',
    'import { ContractSubmissionChannelImpl } from "../phenix-runtime/contract-channel.ts";\n'
    'import type { SubagentSessionRuntime } from "../phenix-runtime/subagent-session-runtime.ts";\n',
)
replace_once(
    coordinator,
    "export interface AgentExecutionCoordinatorOptions {\n"
    "  readonly backend: ChildSessionBackend;\n",
    "export interface AgentExecutionCoordinatorOptions {\n"
    "  readonly backend: ChildSessionBackend;\n"
    "  readonly sessionRuntime: SubagentSessionRuntime;\n",
)
replace_once(
    coordinator,
    "export class AgentExecutionCoordinator {\n"
    "  private readonly backend: ChildSessionBackend;\n",
    "export class AgentExecutionCoordinator {\n"
    "  private readonly backend: ChildSessionBackend;\n"
    "  private readonly sessionRuntime: SubagentSessionRuntime;\n",
)
replace_once(
    coordinator,
    "  constructor(options: AgentExecutionCoordinatorOptions) {\n"
    "    this.backend = options.backend;\n",
    "  constructor(options: AgentExecutionCoordinatorOptions) {\n"
    "    this.backend = options.backend;\n"
    "    this.sessionRuntime = options.sessionRuntime;\n",
)

coordinator_path = Path(coordinator)
coordinator_text = coordinator_path.read_text()
coordinator_text, route_count = re.subn(
    r"\n      // ── Resolve concrete model via routing ─+\n.*?\n      // ── Issue contract and create channel ─+",
    "\n      // ── Issue contract and create channel ─────────────────────────────",
    coordinator_text,
    count=1,
    flags=re.S,
)
if route_count != 1:
    raise RuntimeError(f"expected one producer routing block, found {route_count}")

session_block = '''      // ── Prepare declarative child session request ───────────────────────
      const childRunIdVal = childRunId(`child_${record.id}`);
      const parentRunId =
        parent.kind === "child" && parent.childRunId ? childRunId(parent.childRunId) : undefined;
      const rootRunId =
        parent.kind === "child" && parent.rootChildRunId
          ? childRunId(parent.rootChildRunId)
          : childRunIdVal;
      const sessionRequest = {
        task: params.task,
        session: {
          agent: role,
          thinking: producerSpec.thinking,
          persistence: "file" as const,
        },
        defaults: {
          agent: role,
          modelSet: modelSetId(selectedModelSet),
          difficulty: wfRecord.difficulty,
          thinking: producerSpec.thinking,
          persistence: "file" as const,
        },
        bindings: {
          id: childRunIdVal,
          ...(parentRunId ? { parentId: parentRunId } : {}),
          rootId: rootRunId,
          handleId: record.id,
          cwd: ctx.cwd,
          contract: contractArtifact,
          workflowProjection,
          contractChannel,
          parentContext: {
            kind: "child" as const,
            sessionId,
            cwd: ctx.cwd,
            contractId: contractArtifact.id,
            contract: contractArtifact,
            handleId: record.id,
            childRunId: childRunIdVal,
            rootChildRunId: rootRunId,
            modelSet: selectedModelSet,
            maximumDelegationDepth: contractArtifact.runtime.delegation.remainingDepth,
          },
          effectiveTools: producerSpec.tools.effective,
          skillRefs: producerSpec.skills,
          extensionRefs: producerSpec.extensions,
          inheritProjectContext: true,
          timeoutMs: producerSpec.timeoutMs,
          turnBudget: producerSpec.turnBudget,
          toolBudget: producerSpec.toolBudget,
        },
      };

'''
coordinator_text, spec_count = re.subn(
    r"      // ── Prepare child session spec ─+\n.*?(?=      // ── Start the child run ─+)",
    session_block,
    coordinator_text,
    count=1,
    flags=re.S,
)
if spec_count != 1:
    raise RuntimeError(f"expected one producer session spec block, found {spec_count}")
old_start = "        run = await this.backend.start(spec, runSignal);"
new_start = "        run = await this.sessionRuntime.spawn(sessionRequest, runSignal);"
if coordinator_text.count(old_start) != 1:
    raise RuntimeError("expected one producer backend start call")
coordinator_path.write_text(coordinator_text.replace(old_start, new_start))

replace_once(
    phenix,
    'import { createChildSessionBackend } from "./phenix-runtime/child-session-backend.ts";\n',
    'import {\n'
    '  createChildSessionBackend,\n'
    '  createSubagentSessionRuntime,\n'
    '} from "./phenix-runtime/child-session-backend.ts";\n',
)
replace_once(
    phenix,
    "import {\n  defaultAgentRoutes,\n",
    'import { resolveChildRoute } from "./phenix-routing/child-route.ts";\n'
    "import {\n  defaultAgentRoutes,\n",
)
replace_once(
    phenix,
    "  // ── 7. Construct the coordinator ─────────────────────────────────────\n"
    "  coordinator = new AgentExecutionCoordinator({\n"
    "    backend,\n",
    "  const sessionRuntime = createSubagentSessionRuntime({\n"
    "    backend,\n"
    "    resolveRoute: async ({ modelSet, agent, difficulty }) => {\n"
    "      const route = await resolveChildRoute({ modelSet, role: agent, difficulty });\n"
    "      return {\n"
    "        model: { provider: route.model.provider, id: route.model.model },\n"
    "        thinking: route.thinking,\n"
    "      };\n"
    "    },\n"
    "  });\n\n"
    "  // ── 7. Construct the coordinator ─────────────────────────────────────\n"
    "  coordinator = new AgentExecutionCoordinator({\n"
    "    backend,\n"
    "    sessionRuntime,\n",
)
