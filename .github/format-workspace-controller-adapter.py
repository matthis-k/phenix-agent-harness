from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

workspace_path = ROOT / "modules/phenix-pi/extension/phenix-workspace.ts"
workspace = workspace_path.read_text()
workspace = workspace.replace(
'''  matchesKey,
  sliceByColumn,
  type SlashCommand,
''',
'''  matchesKey,
  type SlashCommand,
  sliceByColumn,
''')
workspace = workspace.replace(
'''  private renderTranscript(
    width: number,
    height: number,
    focus: WorkspaceFocus,
  ): TranscriptRender {
    const snapshot = this.controller.snapshot;
    const selected = findWorkspaceRun(snapshot.ui.tree.root, String(this.controller.state.activeRunId));''',
'''  private renderTranscript(width: number, height: number, focus: WorkspaceFocus): TranscriptRender {
    const snapshot = this.controller.snapshot;
    const selected = findWorkspaceRun(
      snapshot.ui.tree.root,
      String(this.controller.state.activeRunId),
    );''')
workspace = workspace.replace(
'''  private renderSidebar(
    width: number,
    height: number,
    focus: WorkspaceFocus,
  ): SidebarRender {''',
'''  private renderSidebar(width: number, height: number, focus: WorkspaceFocus): SidebarRender {''')
workspace = workspace.replace(
'''  private renderRunSection(
    width: number,
    height: number,
    focus: WorkspaceFocus,
  ): SectionRender {''',
'''  private renderRunSection(width: number, height: number, focus: WorkspaceFocus): SectionRender {''')
workspace = workspace.replace(
'''  private renderTaskSection(
    width: number,
    height: number,
    focus: WorkspaceFocus,
  ): SectionRender {''',
'''  private renderTaskSection(width: number, height: number, focus: WorkspaceFocus): SectionRender {''')
workspace = workspace.replace(
'''  private renderFactSection(
    width: number,
    height: number,
    focus: WorkspaceFocus,
  ): SectionRender {''',
'''  private renderFactSection(width: number, height: number, focus: WorkspaceFocus): SectionRender {''')
workspace = workspace.replace(
'''  private effectiveFocus(): WorkspaceFocus {
    return effectiveFocus(
      this.controller.state.focusedPaneId,
      this.frame.layout.sidebarVisible,
    );
  }''',
'''  private effectiveFocus(): WorkspaceFocus {
    return effectiveFocus(this.controller.state.focusedPaneId, this.frame.layout.sidebarVisible);
  }''')
workspace += '''\nfunction isUp(data: string): boolean {
  return matchesKey(data, "up") || data === "k";
}

function isDown(data: string): boolean {
  return matchesKey(data, "down") || data === "j";
}
'''
workspace_path.write_text(workspace)

adapter_path = ROOT / "modules/phenix-pi/extension/workspace/workspace-controller-adapter.ts"
adapter = adapter_path.read_text()
adapter = adapter.replace(
'''import type {
  WorkspaceEvent,
  WorkspaceSnapshotEnvelope,
} from "../../domain/workspace/events.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import {
  createInitialWorkspaceState,
  type WorkspaceState,
} from "../../domain/workspace/state.ts";''',
'''import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import type { WorkspaceEvent, WorkspaceSnapshotEnvelope } from "../../domain/workspace/events.ts";
import { createInitialWorkspaceState, type WorkspaceState } from "../../domain/workspace/state.ts";''')
adapter = adapter.replace(
'''        if (!node) throw new Error(`Run ${selectedRunId} is not present in the current workspace snapshot`);''',
'''        if (!node)
          throw new Error(`Run ${selectedRunId} is not present in the current workspace snapshot`);''')
adapter = adapter.replace(
'''        transcript.sessionFile ??
        transcript.sessionId ??
        `run:${String(selectedRunId)}:transcript`,''',
'''        transcript.sessionFile ?? transcript.sessionId ?? `run:${String(selectedRunId)}:transcript`,''')
adapter_path.write_text(adapter)

model_path = ROOT / "modules/phenix-pi/extension/workspace/workspace-model.ts"
model = model_path.read_text().replace(
'''    facts: [...snapshot.ui.facts].reverse().slice(0, 50).map((fact) => fact.id),''',
'''    facts: [...snapshot.ui.facts]
      .reverse()
      .slice(0, 50)
      .map((fact) => fact.id),''')
model_path.write_text(model)
