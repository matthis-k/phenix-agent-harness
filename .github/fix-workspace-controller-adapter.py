from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

workspace_path = ROOT / "modules/phenix-pi/extension/phenix-workspace.ts"
workspace = workspace_path.read_text()
workspace = workspace.replace("  type WorkspaceRunRow,\n  type WorkspaceTaskRow,\n", "  type WorkspaceRunRow,\n")
workspace = workspace.replace(
'''  private setTranscriptOffset(value: number): void {
    const offset = clamp(value, 0, this.frame.transcriptMaxOffset);
    this.controller.dispatch({
      type: offset >= this.frame.transcriptMaxOffset ? "scroll.end" : "scroll.set",
      paneId: "transcript",
      ...(offset >= this.frame.transcriptMaxOffset
        ? {}
        : { scroll: { mode: "fixed", offset } as const }),
    } as Parameters<WorkspaceControllerAdapter["dispatch"]>[0]);
  }
''',
'''  private setTranscriptOffset(value: number): void {
    const offset = clamp(value, 0, this.frame.transcriptMaxOffset);
    if (offset >= this.frame.transcriptMaxOffset) {
      this.controller.dispatch({ type: "scroll.end", paneId: "transcript" });
      return;
    }
    this.controller.dispatch({
      type: "scroll.set",
      paneId: "transcript",
      scroll: { mode: "fixed", offset },
    });
  }
''')
workspace = workspace.replace(
'''    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => String(item.node.run.id));
    const title = this.sectionHeader("runs", `RUNS ${items.length}`, width, focus);
    if (pane.collapsed || height <= 1) {
''',
'''    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => String(item.node.run.id));
    if (height <= 0) return { section: "runs", lines: [], offset: 0 };
    const title = this.sectionHeader("runs", `RUNS ${items.length}`, width, focus);
    if (pane.collapsed || height === 1) {
''')
workspace = workspace.replace(
'''    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => item.node.id);
    const title = this.sectionHeader("tasks", `TASKS ${items.length}`, width, focus);
    if (pane.collapsed || height <= 1) {
''',
'''    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => item.node.id);
    if (height <= 0) return { section: "tasks", lines: [], offset: 0 };
    const title = this.sectionHeader("tasks", `TASKS ${items.length}`, width, focus);
    if (pane.collapsed || height === 1) {
''')
workspace = workspace.replace(
'''    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => item.id);
    const title = this.sectionHeader("facts", `RECENT FACTS ${items.length}`, width, focus);
    if (pane.collapsed || height <= 1) {
''',
'''    const selectedIndex = rowIndex(items, pane.selectedItemId, (item) => item.id);
    if (height <= 0) return { section: "facts", lines: [], offset: 0 };
    const title = this.sectionHeader("facts", `RECENT FACTS ${items.length}`, width, focus);
    if (pane.collapsed || height === 1) {
''')
workspace_path.write_text(workspace)

events_path = ROOT / "modules/phenix-pi/domain/workspace/events.ts"
events = events_path.read_text().replace("      readonly resetViewport?: boolean;\n", "")
events_path.write_text(events)

adapter_path = ROOT / "modules/phenix-pi/extension/workspace/workspace-controller-adapter.ts"
adapter = adapter_path.read_text()
adapter = adapter.replace(
'''    return {
      sessionId: transcript.sessionId,
      sessionFile: transcript.sessionFile,
      unavailable: "This workflow run does not own a Pi transcript.",
    };''',
'''    return {
      ...(transcript.sessionId ? { sessionId: transcript.sessionId } : {}),
      ...(transcript.sessionFile ? { sessionFile: transcript.sessionFile } : {}),
      unavailable: "This workflow run does not own a Pi transcript.",
    };''')
adapter = adapter.replace(
'''    return {
      sessionId: node.run.pi.sessionId,
      sessionFile: node.run.pi.sessionFile,
      unavailable: "Pi has allocated this transcript but has not persisted it yet.",
    };''',
'''    return {
      sessionId: node.run.pi.sessionId,
      ...(node.run.pi.sessionFile ? { sessionFile: node.run.pi.sessionFile } : {}),
      unavailable: "Pi has allocated this transcript but has not persisted it yet.",
    };''')
adapter_path.write_text(adapter)

test_path = ROOT / "modules/phenix-pi/tests/phenix-workspace.test.ts"
test = test_path.read_text()
test = test.replace(
'''    [
      ["run-active", 0],
      ["run-active-leaf", 1],
      ["run-completed", 0],
    ],''',
'''    [
      ["root-session", 0],
      ["run-active", 1],
      ["run-active-leaf", 2],
      ["run-completed", 1],
    ],''')
test = test.replace(
'''  assert.deepEqual(allocateWorkspaceSections(30, { runs: false, tasks: true, facts: false }), {
    runs: 17,
    tasks: 2,
    facts: 11,
  });
});''',
'''  assert.deepEqual(allocateWorkspaceSections(30, { runs: false, tasks: true, facts: false }), {
    runs: 17,
    tasks: 2,
    facts: 11,
  });
  for (let height = 0; height <= 8; height += 1) {
    const allocated = allocateWorkspaceSections(height, {
      runs: false,
      tasks: false,
      facts: false,
    });
    assert.ok(allocated.runs + allocated.tasks + allocated.facts <= height);
  }
});''')
test_path.write_text(test)

controller_test_path = ROOT / "modules/phenix-pi/tests/workspace-controller.test.ts"
controller_test = controller_test_path.read_text()
insert = '''\ntest("uses an already-loaded transcript without scheduling an effect", () => {
  const root = runId("root");
  const runtime = new TestRuntime();
  const controller = new WorkspaceController({
    state: {
      ...createInitialWorkspaceState(root),
      transcript: {
        runId: root,
        availability: { kind: "ready", transcript: { key: "root-transcript" } },
        scroll: { mode: "follow-end" },
        horizontalOrigin: 0,
      },
    },
    runtime,
    transcript: {
      handle: { key: "root-transcript" },
      value: { text: "root" },
    },
  });

  assert.deepEqual(controller.currentTranscript, { text: "root" });
  assert.equal(runtime.transcriptCalls.length, 0);
  assert.equal(controller.state.pendingEffects.size, 0);
});
'''
marker = '\ntest("coalesces refresh bursts into the current load plus one follow-up", async () => {'
assert marker in controller_test
controller_test = controller_test.replace(marker, insert + marker)
controller_test_path.write_text(controller_test)
