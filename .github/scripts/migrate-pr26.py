from pathlib import Path
import re

coordinator = Path("modules/phenix-pi/extensions/phenix-subagents/coordinator.ts")
text = coordinator.read_text()

import_line = 'import { createWorkflowExecutionCompiler } from "./workflow-execution-compiler.ts";\n'
anchor = 'import { runVerificationCommands } from "./verification.ts";\n'
if import_line not in text:
    if text.count(anchor) != 1:
        raise RuntimeError("verification import anchor not found exactly once")
    text = text.replace(anchor, anchor + import_line)

compiler_block = '''      // ── Compile the authorized workflow execution ──────────────────────
      const childRunIdVal = childRunId(`child_${record.id}`);
      const parentRunId =
        parent.kind === "child" && parent.childRunId ? childRunId(parent.childRunId) : undefined;
      const rootRunId =
        parent.kind === "child" && parent.rootChildRunId
          ? childRunId(parent.rootChildRunId)
          : childRunIdVal;
      const executionCompiler = createWorkflowExecutionCompiler({
        role,
        modelSet: modelSetId(selectedModelSet),
        difficulty: wfRecord.difficulty,
        thinking: producerSpec.thinking,
        persistence: "file",
        runtime: {
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
        acceptanceKind: "workflow-producer",
        acceptanceData: { handleId: record.id },
      });

'''
text, count = re.subn(
    r"      // ── Prepare declarative child session request .*?\n.*?      const sessionRequest = \{.*?\n      \};\n\n",
    compiler_block,
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError(f"expected one legacy session request block, found {count}")

old_start = "        run = await this.sessionRuntime.spawn(sessionRequest, runSignal);"
new_start = '''        const executionPlan = await executionCompiler.compile(
          {
            task: params.task,
            requirements,
            returns: { schema: outputSchema },
          },
          runSignal,
        );
        run = await this.sessionRuntime.spawn(executionPlan, runSignal);'''
if text.count(old_start) != 1:
    raise RuntimeError("expected one legacy producer spawn call")
text = text.replace(old_start, new_start)
coordinator.write_text(text)

boundary = Path("modules/phenix-pi/tests/workflow-session-runtime.test.ts")
test = boundary.read_text()
test = test.replace(
    r"/this\.sessionRuntime\.spawn\(sessionRequest, runSignal\)/",
    r"/this\.sessionRuntime\.spawn\(executionPlan, runSignal\)/",
)
test = test.replace(
    '"this.sessionRuntime.spawn(sessionRequest, runSignal)"',
    '"this.sessionRuntime.spawn(executionPlan, runSignal)"',
)
test = test.replace(
    "assert.match(coordinator, /modelSet: modelSetId\\(selectedModelSet\\)/);",
    "assert.match(coordinator, /createWorkflowExecutionCompiler\\(\\{/);\n"
    "    assert.match(coordinator, /modelSet: modelSetId\\(selectedModelSet\\)/);",
)
boundary.write_text(test)
