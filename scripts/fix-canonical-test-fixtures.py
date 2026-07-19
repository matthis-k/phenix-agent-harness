from pathlib import Path
import re
import textwrap

root = Path.cwd()
tests = root / "modules" / "phenix-pi" / "tests"
support = tests / "support"
support.mkdir(parents=True, exist_ok=True)

routing_fixture = """\
import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";
import {
  buildRoutingConfigFromDeclarations,
  configureRoutingConfig,
} from "@matthis-k/phenix-routing/config.ts";
import { buildRoleMatrixFromDeclarations } from "@matthis-k/phenix-routing/matrix.ts";
import type { ModelSetId } from "@matthis-k/phenix-routing/types.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "@matthis-k/phenix-suite/defaults/routing.ts";

export function buildDefaultRoutingConfig() {
  return buildRoutingConfigFromDeclarations({
    routing: {
      modelSets: defaultModelSets,
      pools: defaultModelPools,
      agentRoutes: defaultAgentRoutes,
    },
    defaultModelSet: "mixed",
    modelSetOrder: defaultModelSets.map((modelSet) => modelSet.id),
  });
}

export function configureDefaultRouting(): void {
  configureRoutingConfig(buildDefaultRoutingConfig());
}

export const DEFAULT_MODEL_SET_IDS: readonly ModelSetId[] = defaultModelSets.map((definition) =>
  modelSetId(definition.id),
);

export const DEFAULT_PHENIX_MODEL_SETS = DEFAULT_MODEL_SET_IDS;

export function defaultModelSetForModelId(modelId: string): ModelSetId | undefined {
  return DEFAULT_MODEL_SET_IDS.find((id) => id === modelId);
}

export const DEFAULT_ROLE_MATRIX = buildRoleMatrixFromDeclarations(defaultAgentRoutes);

export function allDefaultMatrixKeys() {
  return Object.keys(DEFAULT_ROLE_MATRIX).flatMap((role) =>
    (["D0", "D1", "D2", "D3"] as const).map((difficulty) => ({ role, difficulty })),
  );
}

export function validateDefaultMatrix(): void {
  for (const { role, difficulty } of allDefaultMatrixKeys()) {
    const route = DEFAULT_ROLE_MATRIX[role]?.[difficulty];
    if (!route?.capability || !route.thinking) {
      throw new Error(`Matrix entry ${role}/${difficulty} is incomplete`);
    }
  }
}

configureDefaultRouting();
"""

workflow_fixture = """\
export {
  PHENIX_DEFAULT_WORKFLOW,
  validateDefinition,
} from "@matthis-k/phenix-suite/defaults/workflow.ts";
"""

(support / "default-routing-fixture.ts").write_text(routing_fixture)
(support / "default-workflow-fixture.ts").write_text(workflow_fixture)

def read(name: str) -> str:
    return (tests / name).read_text()

def write(name: str, content: str) -> None:
    (tests / name).write_text(content)

def replace_once(name: str, old: str, new: str) -> None:
    content = read(name)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"{name}: expected one occurrence of {old!r}, found {count}")
    write(name, content.replace(old, new, 1))

def rename(name: str, old: str, new: str) -> None:
    content = read(name)
    updated, count = re.subn(rf"\b{re.escape(old)}\b", new, content)
    if count == 0:
        raise RuntimeError(f"{name}: expected at least one {old}")
    write(name, updated)

for name in [
    "opencode-routing.test.ts",
    "root-workflow-entry-routing.test.ts",
    "routing-integration.test.ts",
    "routing-resolver.test.ts",
]:
    replace_once(
        name,
        'import { buildBundledConfig } from "@matthis-k/phenix-routing/config.ts";',
        'import { buildDefaultRoutingConfig } from "./support/default-routing-fixture.ts";',
    )
    rename(name, "buildBundledConfig", "buildDefaultRoutingConfig")

replace_once(
    "routing-authority.test.ts",
    'import { buildBundledConfig, validateConfig } from "@matthis-k/phenix-routing/config.ts";',
    'import { validateConfig } from "@matthis-k/phenix-routing/config.ts";',
)
replace_once(
    "routing-authority.test.ts",
    'import { ROLE_MATRIX } from "@matthis-k/phenix-routing/matrix.ts";',
    textwrap.dedent("""\
    import {
      buildDefaultRoutingConfig,
      DEFAULT_ROLE_MATRIX,
    } from "./support/default-routing-fixture.ts";"""),
)
rename("routing-authority.test.ts", "buildBundledConfig", "buildDefaultRoutingConfig")
rename("routing-authority.test.ts", "ROLE_MATRIX", "DEFAULT_ROLE_MATRIX")

replace_once(
    "routing-matrix.test.ts",
    textwrap.dedent("""\
    import { buildBundledConfig } from "@matthis-k/phenix-routing/config.ts";
    import { allMatrixKeys, ROLE_MATRIX, validateMatrix } from "@matthis-k/phenix-routing/matrix.ts";
    import {
      type Capability,
      type Difficulty,
      MODEL_SET_IDS,
      type RoutingRole,
    } from "@matthis-k/phenix-routing/types.ts";"""),
    textwrap.dedent("""\
    import {
      allDefaultMatrixKeys,
      buildDefaultRoutingConfig,
      DEFAULT_MODEL_SET_IDS,
      DEFAULT_ROLE_MATRIX,
      validateDefaultMatrix,
    } from "./support/default-routing-fixture.ts";
    import type {
      Capability,
      Difficulty,
      RoutingRole,
    } from "@matthis-k/phenix-routing/types.ts";"""),
)
for old, new in [
    ("buildBundledConfig", "buildDefaultRoutingConfig"),
    ("allMatrixKeys", "allDefaultMatrixKeys"),
    ("ROLE_MATRIX", "DEFAULT_ROLE_MATRIX"),
    ("validateMatrix", "validateDefaultMatrix"),
    ("MODEL_SET_IDS", "DEFAULT_MODEL_SET_IDS"),
]:
    rename("routing-matrix.test.ts", old, new)

replace_once(
    "routing-provider.test.ts",
    textwrap.dedent("""\
    import { buildBundledConfig } from "@matthis-k/phenix-routing/config.ts";
    import {
      modelSetForModelId,
      PHENIX_API,
      PHENIX_MODEL_SETS,
      PHENIX_PROVIDER,
    } from "@matthis-k/phenix-routing/provider.ts";"""),
    textwrap.dedent("""\
    import {
      buildDefaultRoutingConfig,
      DEFAULT_PHENIX_MODEL_SETS,
      defaultModelSetForModelId,
    } from "./support/default-routing-fixture.ts";
    import {
      PHENIX_API,
      PHENIX_PROVIDER,
    } from "@matthis-k/phenix-routing/provider.ts";"""),
)
for old, new in [
    ("buildBundledConfig", "buildDefaultRoutingConfig"),
    ("PHENIX_MODEL_SETS", "DEFAULT_PHENIX_MODEL_SETS"),
    ("modelSetForModelId", "defaultModelSetForModelId"),
]:
    rename("routing-provider.test.ts", old, new)

replace_once(
    "routing-workflow.test.ts",
    textwrap.dedent("""\
    import { buildBundledConfig } from "@matthis-k/phenix-routing/config.ts";
    import { modelSetForModelId, PHENIX_MODEL_SETS } from "@matthis-k/phenix-routing/provider.ts";"""),
    textwrap.dedent("""\
    import {
      buildDefaultRoutingConfig,
      DEFAULT_MODEL_SET_IDS,
      DEFAULT_PHENIX_MODEL_SETS,
      defaultModelSetForModelId,
    } from "./support/default-routing-fixture.ts";"""),
)
replace_once(
    "routing-workflow.test.ts",
    textwrap.dedent("""\
    import type { ModelRef, RoutingRole } from "@matthis-k/phenix-routing/types.ts";
    import { MODEL_SET_IDS, type ModelSetId } from "@matthis-k/phenix-routing/types.ts";"""),
    textwrap.dedent("""\
    import type {
      ModelRef,
      ModelSetId,
      RoutingRole,
    } from "@matthis-k/phenix-routing/types.ts";"""),
)
for old, new in [
    ("buildBundledConfig", "buildDefaultRoutingConfig"),
    ("PHENIX_MODEL_SETS", "DEFAULT_PHENIX_MODEL_SETS"),
    ("modelSetForModelId", "defaultModelSetForModelId"),
    ("MODEL_SET_IDS", "DEFAULT_MODEL_SET_IDS"),
]:
    rename("routing-workflow.test.ts", old, new)

replace_once(
    "routing-state.test.ts",
    textwrap.dedent("""\
    import type { ModelSetId } from "@matthis-k/phenix-routing/types.ts";
    import { MODEL_SET_IDS } from "@matthis-k/phenix-routing/types.ts";"""),
    textwrap.dedent("""\
    import type { ModelSetId } from "@matthis-k/phenix-routing/types.ts";
    import { DEFAULT_MODEL_SET_IDS } from "./support/default-routing-fixture.ts";"""),
)
rename("routing-state.test.ts", "MODEL_SET_IDS", "DEFAULT_MODEL_SET_IDS")

for name, anchor in [
    (
        "identifier-boundaries.test.ts",
        'import { cycleModelSet, validateModelSet } from "@matthis-k/phenix-routing/state.ts";',
    ),
    (
        "routing-stream-failover.test.ts",
        'import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";',
    ),
    (
        "routing-stream-repetition.test.ts",
        'import { modelSetId } from "@matthis-k/phenix-kernel/ids.ts";',
    ),
]:
    replace_once(name, anchor, f'{anchor}\nimport "./support/default-routing-fixture.ts";')

replace_once(
    "workflow-decision-context.test.ts",
    'import { PHENIX_DEFAULT_WORKFLOW } from "@matthis-k/phenix-flow/workflow-definitions.ts";',
    'import { PHENIX_DEFAULT_WORKFLOW } from "./support/default-workflow-fixture.ts";',
)
replace_once(
    "workflow-definitions.test.ts",
    textwrap.dedent("""\
    import {
      PHENIX_DEFAULT_WORKFLOW,
      validateDefinition,
    } from "@matthis-k/phenix-flow/workflow-definitions.ts";"""),
    textwrap.dedent("""\
    import {
      PHENIX_DEFAULT_WORKFLOW,
      validateDefinition,
    } from "./support/default-workflow-fixture.ts";"""),
)
replace_once(
    "workflow-target-agents.test.ts",
    'import { PHENIX_DEFAULT_WORKFLOW } from "@matthis-k/phenix-flow/workflow-definitions.ts";',
    'import { PHENIX_DEFAULT_WORKFLOW } from "./support/default-workflow-fixture.ts";',
)

for name in [
    "contract-store.test.ts",
    "contract-tool-isolation.test.ts",
    "contract.test.ts",
    "execution-quality-service.test.ts",
    "runtime-finalization.test.ts",
    "session-isolation.test.ts",
    "workflow-identifier-authority.test.ts",
    "workflow-store.test.ts",
]:
    replace_once(
        name,
        'import assert from "node:assert/strict";',
        'import assert from "node:assert/strict";\nimport "./support/default-workflow-fixture.ts";',
    )
