from pathlib import Path

root = Path.cwd() / "modules" / "phenix-pi"
packages = root / "packages"

routing_index = packages / "phenix-routing" / "index.ts"
routing_index.write_text('''/**
 * phenix-routing — public facade
 *
 * Pi registration lives exclusively in extension.ts. This facade exposes
 * passive routing state and lookup interfaces only.
 */

export { modelRegistry } from "./registry.ts";
export {
  getActiveRouteForSession,
  setActiveRouteForSession,
} from "./stream-proxy.ts";
''')

subagents = packages / "phenix-suite" / "subagents"
(subagents / "registration.ts").write_text('''import type { WorkflowRuntimePort } from "../runtime/workflow-runtime-types.ts";
import type { WorkflowDelegator } from "./workflow-delegator.ts";

/** Passive inputs required by the Pi subagent registration implementation. */
export interface PhenixSubagentsOptions {
  readonly delegator: WorkflowDelegator;
  readonly workflow: WorkflowRuntimePort;
}
''')
(subagents / "index.ts").write_text('''/** Public facade for suite-owned subagent contracts. */

export type { PhenixSubagentsOptions } from "./registration.ts";
''')

subagent_extension = subagents / "extension.ts"
source = subagent_extension.read_text()
source = source.replace(
    'import type { WorkflowRuntimePort } from "../runtime/workflow-runtime-types.ts";\n',
    '',
)
source = source.replace(
    'import type { WorkflowDelegator } from "./workflow-delegator.ts";\n',
    'import type { PhenixSubagentsOptions } from "./registration.ts";\n',
)
interface_block = '''export interface PhenixSubagentsOptions {
  readonly delegator: WorkflowDelegator;
  readonly workflow: WorkflowRuntimePort;
}

'''
if interface_block not in source:
    raise RuntimeError("subagent registration interface block not found")
source = source.replace(interface_block, '')
subagent_extension.write_text(source)

suite_extension = packages / "phenix-suite" / "extension.ts"
source = suite_extension.read_text()
source = source.replace(
    'import phenixSubagents from "./subagents/index.ts";',
    'import phenixSubagents from "./subagents/extension.ts";',
)
source = source.replace(
    'const mod = await import("@matthis-k/phenix-routing/index.ts");',
    'const mod = await import("@matthis-k/phenix-routing/extension.ts");',
)
suite_extension.write_text(source)

facade_test = root / "tests" / "package-facades.test.ts"
source = facade_test.read_text()
needle = '      assert.equal(facade.includes("pi.register"), false, packageName);\n'
replacement = needle + '      assert.equal(facade.includes("./extension.ts"), false, packageName);\n'
if needle not in source:
    raise RuntimeError("package facade assertion anchor not found")
source = source.replace(needle, replacement, 1)
needle = '    }\n  });\n\n  it("contains no legacy Phenix extension compatibility surface", () => {'
replacement = '''    }

    const subagentFacade = read("packages/phenix-suite/subagents/index.ts");
    assert.equal(subagentFacade.includes("./extension.ts"), false, "phenix-suite/subagents");
  });

  it("contains no legacy Phenix extension compatibility surface", () => {'''
if needle not in source:
    raise RuntimeError("subagent facade assertion anchor not found")
source = source.replace(needle, replacement, 1)
facade_test.write_text(source)
