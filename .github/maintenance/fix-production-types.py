from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace(path: str, old: str, new: str, expected: int = 1) -> None:
    target = ROOT / path
    content = target.read_text()
    count = content.count(old)
    if count != expected:
        raise RuntimeError(f"{path}: expected {expected} matches, found {count}: {old[:120]!r}")
    target.write_text(content.replace(old, new, expected))


# Canonical schema object narrowing.
replace(
    "modules/phenix-pi/extensions/phenix-contracts/validator.ts",
    '''/** Validate schema structure, resource limits, and TypeBox compatibility. */
export function assertJsonSchema(value: unknown): asserts value is JsonSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
''',
    '''function isJsonSchema(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validate schema structure, resource limits, and TypeBox compatibility. */
export function assertJsonSchema(value: unknown): asserts value is JsonSchema {
  if (!isJsonSchema(value)) {
''',
)

# Resource-loader options are derived from the public constructor instead of a removed export.
replace(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-resources.ts",
    '''import type {
  DefaultResourceLoaderOptions,
} from "@earendil-works/pi-coding-agent";
''',
    '''import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export type DefaultResourceLoaderOptions = ConstructorParameters<
  typeof DefaultResourceLoader
>[0];
''',
)
replace(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-resources.ts",
    '  readonly factory: (pi: unknown) => void | Promise<void>;\n',
    '  readonly factory: ExtensionFactory;\n',
)
replace(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-resources.ts",
    '  readonly extensionFactories?: readonly ((pi: unknown) => void | Promise<void>)[];\n',
    '  readonly extensionFactories?: readonly ExtensionFactory[];\n',
)
replace(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-resources.ts",
    '    extensionFactories: [...(input.extensionFactories ?? [])] as any,\n',
    '    extensionFactories: [...(input.extensionFactories ?? [])],\n',
)
replace(
    "modules/phenix-pi/extensions/phenix-runtime/child-session-resources.ts",
    '): Promise<readonly ((pi: unknown) => Promise<void>)[]> {\n',
    '): Promise<readonly ExtensionFactory[]> {\n',
)
for old, new in [
    ('return async (pi: unknown) => {', 'return async (pi: ExtensionAPI) => {'),
    ('await mod.default(pi as any);', 'await mod.default(pi);'),
    ('await mod.default(pi as any, {', 'await mod.default(pi, {'),
]:
    path = "modules/phenix-pi/extensions/phenix-runtime/child-session-resources.ts"
    content = (ROOT / path).read_text()
    count = content.count(old)
    if count == 0:
        raise RuntimeError(f"{path}: missing integration pattern {old!r}")
    (ROOT / path).write_text(content.replace(old, new))

# The TypeBox schema owns delegation parameter types.
coordinator_path = ROOT / "modules/phenix-pi/extensions/phenix-subagents/coordinator.ts"
coordinator = coordinator_path.read_text()
coordinator = coordinator.replace(
    'import type { ParentExecutionContext } from "../phenix-runtime/delegation-tool.ts";',
    'import type {\n  DelegateExecutionParams,\n  ParentExecutionContext,\n} from "../phenix-runtime/delegation-tool.ts";',
    1,
)
pattern = re.compile(
    r'// ── Delegate execution parameters .*?export type DelegateExecutionResult =',
    re.DOTALL,
)
match = pattern.search(coordinator)
if not match:
    raise RuntimeError("coordinator: delegate parameter block not found")
coordinator = coordinator[: match.start()] + '// ── Delegate execution result ───────────────────────────────────────────────\n\nexport type DelegateExecutionResult =' + coordinator[match.end() :]
coordinator = coordinator.replace(
    '''    const selectedModelSet =
      parent.kind === "child" && parent.modelSet
        ? parent.modelSet
        : ctx.model.provider === PHENIX_PROVIDER
          ? (modelSetForModelId(ctx.model.id) ?? this.activeModelSet)
          : this.activeModelSet;
''',
    '''    const selectedModelSet =
      parent.kind === "child" && parent.modelSet
        ? parent.modelSet
        : ctx.model?.provider === PHENIX_PROVIDER
          ? (modelSetForModelId(ctx.model.id) ?? this.activeModelSet)
          : this.activeModelSet;
''',
    1,
)
coordinator_path.write_text(coordinator)

# Root tool results do not carry an isError field in Pi 0.80.
replace(
    "modules/phenix-pi/extensions/phenix-subagents/index.ts",
    '    isError: true,\n',
    '',
)
replace(
    "modules/phenix-pi/extensions/phenix-subagents/index.ts",
    '      signal: AbortSignal,\n',
    '      signal: AbortSignal | undefined,\n',
    expected=2,
)
replace(
    "modules/phenix-pi/extensions/phenix-subagents/index.ts",
    '          signal,\n',
    '          signal: signal ?? new AbortController().signal,\n',
)
replace(
    "modules/phenix-pi/extensions/phenix-subagents/index.ts",
    '        const resolved = await coordinator.awaitHandle(ctx, params.id, signal);\n',
    '        const resolved = await coordinator.awaitHandle(\n          ctx,\n          params.id,\n          signal ?? new AbortController().signal,\n        );\n',
)

# Composition root: native tool type, current UI API, and no removed RPC fields.
replace(
    "modules/phenix-pi/extensions/phenix.ts",
    'import type { ExtensionAPI, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";\n',
    'import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";\n',
)
replace(
    "modules/phenix-pi/extensions/phenix.ts",
    '      ctx.ui.setStatus(`Phenix · ${activeCount} active child${activeCount !== 1 ? "ren" : ""}`);\n',
    '      ctx.ui.setStatus(\n        "phenix",\n        `Phenix · ${activeCount} active child${activeCount !== 1 ? "ren" : ""}`,\n      );\n',
)
replace(
    "modules/phenix-pi/extensions/phenix.ts",
    '''      // The runtime tool is structurally compatible with Pi. Keep this
      // conversion at the composition boundary rather than in domain code.
      return [delegationTool as unknown as ToolDefinition];
''',
    '      return [delegationTool];\n',
)
replace(
    "modules/phenix-pi/extensions/phenix.ts",
    '''    ...(defaultPhenixConfiguration.runtime.rpc
      ? { rpc: defaultPhenixConfiguration.runtime.rpc }
      : {}),
''',
    '',
)
replace(
    "modules/phenix-pi/extensions/phenix.ts",
    '        `Backend: ${defaultPhenixConfiguration.runtime.childSessionBackend}`,\n',
    '        "Backend: sdk",\n',
)
