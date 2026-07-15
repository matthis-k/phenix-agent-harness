from pathlib import Path

root = Path("modules/phenix-pi")

path = root / "extensions/phenix-subagents/workflow-delegator.ts"
text = path.read_text()
old = '''import type {
  DelegateExecutionParams,
  ParentExecutionContext,
} from "../phenix-runtime/delegation-tool.ts";
'''
new = '''import type { ParentExecutionContext } from "../phenix-runtime/workflow-api-types.ts";
import type { DelegateParamsType as DelegateExecutionParams } from "./delegate-schema.ts";
'''
if text.count(old) != 1:
    raise RuntimeError("workflow-delegator import block changed")
path.write_text(text.replace(old, new))

path = root / "extensions/phenix.ts"
text = path.read_text()
text = text.replace(
    'import { createDelegationTool } from "./phenix-runtime/delegation-tool.ts";\n',
    'import { createWorkflowApiTools, type WorkflowApiPort } from "./phenix-runtime/workflow-api-tools.ts";\n',
)
text = text.replace(
    'import { createWorkflowAcceptanceEngine } from "./phenix-subagents/workflow-acceptance-engine.ts";\n',
    'import { createWorkflowAcceptanceEngine } from "./phenix-subagents/workflow-acceptance-engine.ts";\nimport { createWorkflowApi } from "./phenix-subagents/workflow-api.ts";\n',
)
text = text.replace(
    '      "Use `phenix_delegate` for real isolated subagents. Raw `subagent` calls are runtime-blocked so model selection, thinking, permissions, persistence, contracts, and verification cannot be bypassed.",',
    '      "Use the Phenix workflow API for every subagent decision: call `phenix_workflow` to inspect current authority, then `phenix_create_subagent` with one returned transition. Raw `subagent` and legacy `phenix_delegate` calls are runtime-blocked.",',
)
text = text.replace(
    '  let delegator!: WorkflowDelegator;\n',
    '  let delegator!: WorkflowDelegator;\n  let workflowApi!: WorkflowApiPort;\n',
)
old = '''      const delegationTool = createDelegationTool({
        delegator,
        parent: spec.parentContext,
        decisionContext: spec.workflowProjection,
      });
      return [delegationTool as unknown as ToolDefinition];
'''
new = '''      return createWorkflowApiTools({
        workflow: workflowApi,
        parent: spec.parentContext,
        allowCreate:
          spec.contract.runtime.delegation.remainingDepth > 0 &&
          spec.contract.runtime.delegation.availableRoles.length > 0,
      }) as readonly ToolDefinition[];
'''
if text.count(old) != 1:
    raise RuntimeError("child custom tool composition changed")
text = text.replace(old, new)
old = '''  delegator = new WorkflowDelegator({
    delegationRuntime,
    activeModelSet: linkResult.graph.activeModelSet.id,
    maximumDelegationDepth: defaultPhenixConfiguration.runtime.maximumDelegationDepth,
  });

  await loadIntegration("phenix-subagents", pi, async (api) => {
    await phenixSubagents(api, { delegator });
  });
'''
new = '''  delegator = new WorkflowDelegator({
    delegationRuntime,
    activeModelSet: linkResult.graph.activeModelSet.id,
    maximumDelegationDepth: defaultPhenixConfiguration.runtime.maximumDelegationDepth,
  });
  workflowApi = createWorkflowApi({
    delegator,
    maximumDelegationDepth: defaultPhenixConfiguration.runtime.maximumDelegationDepth,
  });

  await loadIntegration("phenix-subagents", pi, async (api) => {
    await phenixSubagents(api, { delegator, workflow: workflowApi });
  });
'''
if text.count(old) != 1:
    raise RuntimeError("root workflow API composition changed")
path.write_text(text.replace(old, new))

path = root / "extensions/phenix-subagents/index.ts"
text = path.read_text()
text = text.replace(
    ' * Registers the root-visible phenix_delegate and phenix_agent tools.\n',
    ' * Registers the root-visible workflow API and phenix_agent tools.\n',
)
text = text.replace(
    'import { AgentParams, DelegateParams } from "./delegate-schema.ts";\n',
    'import { createWorkflowApiTools, type WorkflowApiPort } from "../phenix-runtime/workflow-api-tools.ts";\nimport { AgentParams } from "./delegate-schema.ts";\n',
)
text = text.replace(
    '  readonly delegator: WorkflowDelegator;\n',
    '  readonly delegator: WorkflowDelegator;\n  readonly workflow: WorkflowApiPort;\n',
)
text = text.replace(
    '  const delegator = options.delegator;\n',
    '  const delegator = options.delegator;\n  const workflow = options.workflow;\n',
)
text = text.replace(
    '// Block raw subagent globally — only phenix_delegate is allowed.',
    '// Block raw and legacy delegation globally — only the workflow API is allowed.',
)
text = text.replace(
    '    if (toolName === "subagent") {\n',
    '    if (toolName === "subagent" || toolName === "phenix_delegate") {\n',
)
text = text.replace(
    '          "Raw subagent calls are runtime-blocked in Phenix sessions. Use phenix_delegate instead.",',
    '          "Raw or legacy delegation is runtime-blocked in Phenix sessions. Call phenix_workflow, then phenix_create_subagent.",',
)
start = text.index('  // ── phenix_delegate tool')
end = text.index('  // ── phenix_agent tool', start)
text = text[:start] + '''  // ── Contract-bound workflow API ────────────────────────────────────────

  for (const tool of createWorkflowApiTools({ workflow, allowCreate: true })) {
    pi.registerTool(tool as never);
  }

''' + text[end:]
path.write_text(text)

path = root / "extensions/phenix-runtime/sdk-child-session-backend.ts"
text = path.read_text()
text = text.replace(
    '    // Delegation tools, when legal, are supplied by the composition root.',
    '    // Contract-derived workflow API tools are supplied by the composition root.',
)
text = text.replace(
    ' * Includes effective tools plus required runtime tools (phenix_complete,\n * phenix_delegate when delegation is legal). Deduplicates and sorts.',
    ' * Includes effective tools plus required runtime tools. `phenix_workflow` is\n * always installed; `phenix_create_subagent` is installed only when the loaded\n * contract retains delegation depth and at least one available role.',
)
old = '''  const canDelegate =
    spec.contract.runtime.delegation.remainingDepth > 0 &&
    spec.contract.runtime.delegation.availableRoles.length > 0 &&
    spec.workflowProjection.options.length > 0;

  const baseTools = spec.effectiveTools.filter(
    (tool) =>
      tool !== "phenix_complete" &&
      (tool !== "phenix_delegate" || canDelegate),
  );
  const toolNames = [
    ...baseTools,
    "phenix_complete",
    ...(canDelegate ? ["phenix_delegate"] : []),
  ];
'''
new = '''  const canCreateSubagent =
    spec.contract.runtime.delegation.remainingDepth > 0 &&
    spec.contract.runtime.delegation.availableRoles.length > 0;

  const runtimeTools = new Set([
    "phenix_complete",
    "phenix_workflow",
    "phenix_create_subagent",
    "phenix_delegate",
  ]);
  const baseTools = spec.effectiveTools.filter((tool) => !runtimeTools.has(tool));
  const toolNames = [
    ...baseTools,
    "phenix_complete",
    "phenix_workflow",
    ...(canCreateSubagent ? ["phenix_create_subagent"] : []),
  ];
'''
if text.count(old) != 1:
    raise RuntimeError("SDK effective tool block changed")
path.write_text(text.replace(old, new))

path = root / "extensions/phenix-runtime/child-session-prompt.ts"
text = path.read_text()
text = text.replace(
    '''  // 5-6, 8. Effective tool/delegation boundaries, legal delegation options, workflow state
  if (workflowProjection.options.length > 0) {
    sections.push(formatWorkflowProjection(workflowProjection));
  }
''',
    '''  // 5-6, 8. Effective tool/delegation boundaries, legal delegation options, workflow state
  sections.push(formatWorkflowProjection(workflowProjection));
''',
)
text = text.replace(
    '        "The phenix_complete tool is always available for submitting your result.",\n        "The phenix_delegate tool is available only when delegation is legal and listed above.",',
    '        "The phenix_complete tool is always available for submitting your result.",\n        "The phenix_workflow tool is always available and is the source of truth for current workflow authority.",\n        "The phenix_create_subagent tool is installed only when the initialized contract permits delegation.",',
)
text = text.replace(
    '        "No further delegation is permitted in this session. " +\n        "Complete the assignment directly using phenix_complete.",',
    '        "The initialized contract permits no further subagent creation. " +\n        "phenix_workflow will report no creatable transitions; complete the assignment directly using phenix_complete.",',
)
path.write_text(text)

path = root / "extensions/phenix-workflow/workflow-projection.ts"
text = path.read_text()
text = text.replace('    `Authority digest: ${projection.optionsDigest}`,\n', '')
text = text.replace(
    '      "No delegation transition is currently legal.",\n      "Complete the current assignment using phenix_complete.",',
    '      "No subagent creation transition is currently legal.",\n      "Use phenix_workflow again after workflow state changes; otherwise complete the current assignment using phenix_complete.",',
)
old = '''  lines.push(
    "Call phenix_delegate with exactly:",
    "- transitionId: one transition ID listed above",
    "- workflowRevision: the workflow revision shown above",
    "- authorityDigest: the authority digest shown above",
    "- task: the bounded objective for the child",
    "- optional: requirements, tools narrowing, delegateRoles narrowing, mode",
    "",
    "Do not invent a role, transition, result schema, model, or thinking level.",
  );
'''
new = '''  lines.push(
    "Workflow API protocol:",
    "1. Call phenix_workflow immediately before creating a subagent.",
    "2. Select one transitionId returned by that call.",
    "3. Call phenix_create_subagent with the transitionId and bounded task.",
    "The runtime injects the current workflow revision and authority digest.",
    "Do not invent a role, transition, result schema, model, thinking level, tool set, or delegation depth.",
  );
'''
if text.count(old) != 1:
    raise RuntimeError("workflow projection protocol changed")
path.write_text(text.replace(old, new))

path = root / "extensions/phenix-composition/root-workflow-integration.ts"
text = path.read_text()
old = '''    workflowGuidance +=
      "The deterministic Phenix workflow owns role selection, output schemas, and models. ";
    workflowGuidance += "Only delegate through the transitions projected below.\n\n";
'''
new = '''    workflowGuidance +=
      "The deterministic Phenix workflow owns role selection, output schemas, models, tools, and delegation depth. ";
    workflowGuidance +=
      "Use the workflow API: call phenix_workflow for fresh authority, then phenix_create_subagent with one returned transition.\n\n";
'''
if text.count(old) != 1:
    raise RuntimeError("root workflow guidance changed")
path.write_text(text.replace(old, new))

for path in (root / "agents").glob("*.md"):
    text = path.read_text().replace("phenix_delegate", "phenix_workflow, phenix_create_subagent")
    text = text.replace(
        "Use phenix_workflow, phenix_create_subagent only for permitted",
        "Call phenix_workflow to inspect current authority, then use phenix_create_subagent only for permitted",
    )
    path.write_text(text)

for path in [
    root / "skills/phenix-subagents/SKILL.md",
    root / "skills/phenix-qa/rules/no-raw-subagent.yml",
    Path("tests/delegate-flow-test.sh"),
    Path("tests/delegate-invalid-schema-test.sh"),
    Path("modules/standalone.nix"),
]:
    if path.exists():
        path.write_text(path.read_text().replace("phenix_delegate", "phenix_create_subagent"))

for path in [
    root / "extensions/phenix-subagents/role-presets.ts",
    root / "extensions/phenix-subagents/policy.ts",
]:
    text = path.read_text().replace(
        '"phenix_delegate",',
        '"phenix_workflow",\n  "phenix_create_subagent",',
    )
    path.write_text(text)

path = root / "extensions/phenix-runtime/child-session-types.ts"
path.write_text(path.read_text().replace("closure-bound phenix_delegate tool", "closure-bound workflow API"))

old_tool = root / "extensions/phenix-runtime/delegation-tool.ts"
if old_tool.exists():
    old_tool.unlink()
