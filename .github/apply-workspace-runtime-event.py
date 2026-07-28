from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

binding = ROOT / "modules/phenix-pi/extension/workspace-runtime-binding.ts"
binding.write_text('''import type { PhenixRuntime } from "../composition/create-phenix-runtime.ts";
import type { RunId } from "../domain/shared.ts";

export const WORKSPACE_RUNTIME_EVENT = "phenix:workspace-runtime";

export interface WorkspaceRuntimeBinding {
  readonly runtime: PhenixRuntime;
  readonly rootRunId: RunId;
  readonly integrations: string;
}

export interface WorkspaceRuntimeEventBus {
  readonly on: (event: string, listener: (value: unknown) => void) => unknown;
  readonly emit: (event: string, value: unknown) => unknown;
}

type Listener = (binding: WorkspaceRuntimeBinding | undefined) => void;

type WorkspaceRuntimeEvent =
  | { readonly kind: "ready"; readonly binding: WorkspaceRuntimeBinding }
  | { readonly kind: "cleared"; readonly rootRunId: RunId };

export function publishWorkspaceRuntime(
  events: WorkspaceRuntimeEventBus,
  binding: WorkspaceRuntimeBinding,
): void {
  events.emit(WORKSPACE_RUNTIME_EVENT, {
    kind: "ready",
    binding,
  } satisfies WorkspaceRuntimeEvent);
}

export function clearWorkspaceRuntime(
  events: WorkspaceRuntimeEventBus,
  rootRunId: RunId,
): void {
  events.emit(WORKSPACE_RUNTIME_EVENT, {
    kind: "cleared",
    rootRunId,
  } satisfies WorkspaceRuntimeEvent);
}

export function subscribeWorkspaceRuntime(
  events: WorkspaceRuntimeEventBus,
  listener: Listener,
): void {
  let currentRootRunId: RunId | undefined;
  events.on(WORKSPACE_RUNTIME_EVENT, (value) => {
    const event = parseWorkspaceRuntimeEvent(value);
    if (!event) return;
    if (event.kind === "ready") {
      currentRootRunId = event.binding.rootRunId;
      listener(event.binding);
      return;
    }
    if (currentRootRunId && event.rootRunId !== currentRootRunId) return;
    currentRootRunId = undefined;
    listener(undefined);
  });
}

function parseWorkspaceRuntimeEvent(value: unknown): WorkspaceRuntimeEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "ready" && isWorkspaceRuntimeBinding(value.binding)) {
    return { kind: "ready", binding: value.binding };
  }
  if (value.kind === "cleared" && typeof value.rootRunId === "string") {
    return { kind: "cleared", rootRunId: value.rootRunId as RunId };
  }
  return undefined;
}

function isWorkspaceRuntimeBinding(value: unknown): value is WorkspaceRuntimeBinding {
  return (
    isRecord(value) &&
    isRecord(value.runtime) &&
    typeof value.rootRunId === "string" &&
    typeof value.integrations === "string"
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
''')

root_extension = ROOT / "modules/phenix-pi/extension/root-extension.ts"
root = root_extension.read_text()
old = "if (currentRoot) clearWorkspaceRuntime(currentRoot);"
new = "if (currentRoot) clearWorkspaceRuntime(pi.events, currentRoot);"
assert root.count(old) == 1, root.count(old)
root = root.replace(old, new)
old = "    publishWorkspaceRuntime({\n      runtime: currentRuntime,"
new = "    publishWorkspaceRuntime(pi.events, {\n      runtime: currentRuntime,"
assert root.count(old) == 1, root.count(old)
root = root.replace(old, new)
root_extension.write_text(root)

workspace_extension = ROOT / "modules/phenix-pi/extension/default-workspace-extension.ts"
workspace = workspace_extension.read_text()
old = '''import {
  currentWorkspaceRuntime,
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";'''
new = '''import {
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
} from "./workspace-runtime-binding.ts";'''
assert workspace.count(old) == 1, workspace.count(old)
workspace = workspace.replace(old, new)
workspace = workspace.replace('  let unsubscribeBinding: (() => void) | undefined;\n', '')
old = '''  const requestOpen = (): void => {
    if (opening || workspace || context?.mode !== "tui" || !binding) return;
    void openWorkspaceLoop();
  };

  pi.registerCommand("workspace", {'''
new = '''  const requestOpen = (): void => {
    if (opening || workspace || context?.mode !== "tui" || !binding) return;
    void openWorkspaceLoop();
  };

  subscribeWorkspaceRuntime(pi.events, (next) => {
    binding = next;
    if (!next) {
      finish?.({ kind: "close" });
      return;
    }
    requestOpen();
  });

  pi.registerCommand("workspace", {'''
assert workspace.count(old) == 1, workspace.count(old)
workspace = workspace.replace(old, new)
old = '''      binding = currentWorkspaceRuntime();
      if (!binding) {'''
new = '''      if (!binding) {'''
assert workspace.count(old) == 1, workspace.count(old)
workspace = workspace.replace(old, new)
old = '''  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    unsubscribeBinding?.();
    unsubscribeBinding = subscribeWorkspaceRuntime((next) => {
      binding = next;
      if (!next) {
        finish?.({ kind: "close" });
        return;
      }
      requestOpen();
    });
  });'''
new = '''  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    requestOpen();
  });'''
assert workspace.count(old) == 1, workspace.count(old)
workspace = workspace.replace(old, new)
old = '''  pi.on("session_shutdown", () => {
    unsubscribeBinding?.();
    unsubscribeBinding = undefined;
    finish?.({ kind: "close" });
    workspace = undefined;
    context = undefined;
    binding = undefined;
  });'''
new = '''  pi.on("session_shutdown", () => {
    finish?.({ kind: "close" });
    workspace = undefined;
    context = undefined;
    binding = undefined;
  });'''
assert workspace.count(old) == 1, workspace.count(old)
workspace = workspace.replace(old, new)
workspace_extension.write_text(workspace)

test_file = ROOT / "modules/phenix-pi/tests/workspace-runtime-binding.test.ts"
test_file.write_text('''import assert from "node:assert/strict";
import test from "node:test";

import {
  clearWorkspaceRuntime,
  publishWorkspaceRuntime,
  subscribeWorkspaceRuntime,
  type WorkspaceRuntimeBinding,
  type WorkspaceRuntimeEventBus,
} from "../extension/workspace-runtime-binding.ts";

class TestEventBus implements WorkspaceRuntimeEventBus {
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  on(event: string, listener: (value: unknown) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function binding(rootRunId: string): WorkspaceRuntimeBinding {
  return {
    runtime: {} as WorkspaceRuntimeBinding["runtime"],
    rootRunId: rootRunId as WorkspaceRuntimeBinding["rootRunId"],
    integrations: "healthy",
  };
}

test("propagates runtime readiness across extension entry points through Pi events", () => {
  const events = new TestEventBus();
  const received: Array<WorkspaceRuntimeBinding | undefined> = [];
  subscribeWorkspaceRuntime(events, (value) => received.push(value));

  const ready = binding("root-session");
  publishWorkspaceRuntime(events, ready);
  clearWorkspaceRuntime(events, ready.rootRunId);

  assert.deepEqual(received, [ready, undefined]);
});

test("ignores stale clears and malformed shared events", () => {
  const events = new TestEventBus();
  const received: Array<WorkspaceRuntimeBinding | undefined> = [];
  subscribeWorkspaceRuntime(events, (value) => received.push(value));

  const ready = binding("root-current");
  publishWorkspaceRuntime(events, ready);
  clearWorkspaceRuntime(events, "root-stale" as WorkspaceRuntimeBinding["rootRunId"]);
  events.emit("phenix:workspace-runtime", { kind: "ready", binding: null });

  assert.deepEqual(received, [ready]);
});
''')
