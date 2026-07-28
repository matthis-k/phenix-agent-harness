from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

reducer_path = ROOT / "modules/phenix-pi/application/workspace/reducer.ts"
reducer = reducer_path.read_text()
reducer = reducer.replace(
    '''import type { RunId } from "../../domain/shared.ts";
import type {
  WorkspaceEffect,
  WorkspaceEvent,
  WorkspaceItemIndex,
} from "../../domain/workspace/events.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";''',
    '''import type { RunId } from "../../domain/shared.ts";
import type { WorkspaceError } from "../../domain/workspace/errors.ts";
import type {
  WorkspaceEffect,
  WorkspaceEvent,
  WorkspaceItemIndex,
} from "../../domain/workspace/events.ts";''',
)
reducer = reducer.replace(
    '''    return commit(
      { ...state, pendingEffects },
      [diagnostic(staleError(event.requestId, "Snapshot completion is older than current state"))],
    );''',
    '''    return commit({ ...state, pendingEffects }, [
      diagnostic(staleError(event.requestId, "Snapshot completion is older than current state")),
    ]);''',
)
reducer = reducer.replace(
    '''    return withDiagnostic(state, invalidInput("Fixed scroll offsets must be non-negative integers"));''',
    '''    return withDiagnostic(
      state,
      invalidInput("Fixed scroll offsets must be non-negative integers"),
    );''',
)
reducer = reducer.replace(
    '''  return commit(
    { ...state, pendingEffects: withoutEffect(state.pendingEffects, requestId) },
    [diagnostic(error)],
  );''',
    '''  return commit({ ...state, pendingEffects: withoutEffect(state.pendingEffects, requestId) }, [
    diagnostic(error),
  ]);''',
)
reducer = reducer.replace(
    '''function selectedProperty(selectedItemId: string | undefined): { readonly selectedItemId?: string } {''',
    '''function selectedProperty(selectedItemId: string | undefined): {
  readonly selectedItemId?: string;
} {''',
)
reducer_path.write_text(reducer)

port_path = ROOT / "modules/phenix-pi/ports/workspace-effects.ts"
port = port_path.read_text()
port = port.replace(
    '''import type { RunId } from "../domain/shared.ts";
import type {
  WorkspaceEffect,
  WorkspaceSnapshotEnvelope,
} from "../domain/workspace/events.ts";
import type { WorkspaceError } from "../domain/workspace/errors.ts";''',
    '''import type { RunId } from "../domain/shared.ts";
import type { WorkspaceError } from "../domain/workspace/errors.ts";
import type { WorkspaceEffect, WorkspaceSnapshotEnvelope } from "../domain/workspace/events.ts";''',
)
port_path.write_text(port)

controller_test_path = ROOT / "modules/phenix-pi/tests/workspace-controller.test.ts"
controller_test = controller_test_path.read_text()
start = controller_test.index('import assert from "node:assert/strict";')
end = controller_test.index('\n\ninterface SnapshotValue')
controller_test = controller_test[:start] + '''import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceController } from "../application/workspace/controller.ts";
import { type RunId, runId } from "../domain/shared.ts";
import type { WorkspaceError } from "../domain/workspace/errors.ts";
import type { WorkspaceItemIndex, WorkspaceSnapshotEnvelope } from "../domain/workspace/events.ts";
import { createInitialWorkspaceState } from "../domain/workspace/state.ts";
import type {
  LoadedWorkspaceTranscript,
  WorkspaceEffectRuntime,
} from "../ports/workspace-effects.ts";''' + controller_test[end:]
controller_test = controller_test.replace(
    '''  return Object.fromEntries(PANES.map((paneId) => [paneId, items[paneId] ?? []])) as WorkspaceItemIndex;''',
    '''  return Object.fromEntries(
    PANES.map((paneId) => [paneId, items[paneId] ?? []]),
  ) as WorkspaceItemIndex;''',
)
controller_test_path.write_text(controller_test)

reducer_test_path = ROOT / "modules/phenix-pi/tests/workspace-reducer.test.ts"
reducer_test = reducer_test_path.read_text()
start = reducer_test.index('import assert from "node:assert/strict";')
end = reducer_test.index('\n\nconst effectId')
reducer_test = reducer_test[:start] + '''import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileSelection,
  reduceWorkspace,
} from "../application/workspace/reducer.ts";
import { runId } from "../domain/shared.ts";
import type { WorkspaceItemIndex, WorkspaceSnapshotEnvelope } from "../domain/workspace/events.ts";
import type { EffectId, PaneId, WorkspaceState } from "../domain/workspace/state.ts";
import { createInitialWorkspaceState } from "../domain/workspace/state.ts";''' + reducer_test[end:]
reducer_test = reducer_test.replace(
    '''  return Object.fromEntries(PANES.map((paneId) => [paneId, items[paneId] ?? []])) as WorkspaceItemIndex;''',
    '''  return Object.fromEntries(
    PANES.map((paneId) => [paneId, items[paneId] ?? []]),
  ) as WorkspaceItemIndex;''',
)
reducer_test_path.write_text(reducer_test)
