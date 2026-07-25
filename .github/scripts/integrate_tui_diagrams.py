from pathlib import Path
import re


root_extension_path = Path("modules/phenix-pi/extension/root-extension.ts")
source = root_extension_path.read_text()

if 'import { Type } from "typebox";' not in source:
    source = source.replace(
        'import path from "node:path";\n\n',
        'import path from "node:path";\n\nimport { Type } from "typebox";\n\n',
        1,
    )
if 'definitionRef, type AnyDefinition' not in source:
    source = source.replace(
        'import { isPhenixModelSet, PHENIX_MODEL_SETS } from "../domain/definition/model.ts";\n',
        'import { definitionRef, type AnyDefinition } from "../domain/definition/definition.ts";\n'
        'import { isPhenixModelSet, PHENIX_MODEL_SETS } from "../domain/definition/model.ts";\n',
        1,
    )
if './mermaid-rendering.ts' not in source:
    source = source.replace(
        'import { formatDiagnosticEntries, PHENIX_LOGS_USAGE, parseLogsCommand } from "./log-command.ts";\n',
        'import { formatDiagnosticEntries, PHENIX_LOGS_USAGE, parseLogsCommand } from "./log-command.ts";\n'
        'import { renderCatalogDefinition, renderTerminalMermaid } from "./mermaid-rendering.ts";\n',
        1,
    )
if 'registerMermaidTool(pi);' not in source:
    source = source.replace(
        '  let integrationStatuses: readonly IntegrationStatus[] = [];\n\n  registerPhenixProvider(pi, {',
        '  let integrationStatuses: readonly IntegrationStatus[] = [];\n\n'
        '  registerMermaidTool(pi);\n'
        '  registerPhenixProvider(pi, {',
        1,
    )
if 'Use phenix_render_mermaid for user-facing' not in source:
    source = source.replace(
        '- Use phenix_tasks only for local leaves; execution anchors are derived and read-only.`',
        '- Use phenix_tasks only for local leaves; execution anchors are derived and read-only.\\n'
        '- Use phenix_render_mermaid for user-facing flowcharts, sequence diagrams, state diagrams, and architecture sketches instead of manually aligned terminal art.`',
        1,
    )

catalog_re = re.compile(
    r'      if \(action === "catalog"\) \{.*?\n      \}\n      if \(action === "logs"\) \{',
    re.S,
)
catalog_block = '''      if (action === "catalog") {
        const definitions = await activeRuntime.catalog.listAvailable(activeRoot);
        const query = rawOptions.trim().toLowerCase();
        if (!query) {
          ctx.ui.notify(
            definitions.map((definition) => `${definition.id} — ${definition.title}`).join("\\n"),
            "info",
          );
          return;
        }
        const matches = definitions.filter((definition) => {
          const id = String(definition.id).toLowerCase();
          const shortId = id.replace(/^(?:agent|workflow)\\./, "");
          return id === query || shortId === query || definition.title.toLowerCase() === query;
        });
        if (matches.length !== 1) {
          ctx.ui.notify(
            matches.length === 0
              ? `Catalog definition not found: ${rawOptions}`
              : `Catalog selector is ambiguous: ${matches.map((item) => item.id).join(", ")}`,
            "warning",
          );
          return;
        }
        const definition = activeRuntime.catalog.get(
          definitionRef(matches[0]!.id),
        ) as AnyDefinition;
        ctx.ui.notify(limit(renderCatalogDefinition(definition)), "info");
        return;
      }
      if (action === "logs") {'''
source, count = catalog_re.subn(lambda _: catalog_block, source, count=1)
if count != 1:
    raise SystemExit("catalog handler not found")

if '    "phenix_render_mermaid",' not in source:
    source = source.replace(
        '    "phenix_tasks",\n  ] as const;',
        '    "phenix_tasks",\n    "phenix_render_mermaid",\n  ] as const;',
        1,
    )

if 'function registerMermaidTool(' not in source:
    marker = "function registerAgentTool(\n"
    tool = '''function registerMermaidTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "phenix_render_mermaid",
    label: "Render Mermaid",
    description:
      "Render Mermaid source as terminal Unicode or plain ASCII. Use for user-facing flowcharts, sequence diagrams, state diagrams, class diagrams, ER diagrams, and architecture/design documentation.",
    promptSnippet:
      "Use phenix_render_mermaid when a diagram communicates a workflow, interaction sequence, state machine, or architecture more clearly than prose.",
    parameters: Type.Object({
      source: Type.String({ minLength: 1, maxLength: 64_000 }),
      ascii: Type.Optional(Type.Boolean()),
      compact: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, input) {
      const params = input as {
        readonly source: string;
        readonly ascii?: boolean;
        readonly compact?: boolean;
      };
      const rendered = renderTerminalMermaid(params.source, {
        useAscii: params.ascii ?? false,
        compact: params.compact ?? false,
      });
      return {
        content: [{ type: "text" as const, text: rendered }],
        details: { source: params.source, format: params.ascii ? "ascii" : "unicode" },
      };
    },
  } as ToolDefinition);
}

'''
    if marker not in source:
        raise SystemExit("registerAgentTool marker not found")
    source = source.replace(marker, tool + marker, 1)

root_extension_path.write_text(source)

monitor_path = Path("modules/phenix-pi/extension/run-monitor.ts")
monitor = monitor_path.read_text()
if './mermaid-rendering.ts' not in monitor:
    monitor = monitor.replace(
        'import type { RunId } from "../domain/shared.ts";\n',
        'import type { RunId } from "../domain/shared.ts";\n'
        'import { renderRunTreeSequence } from "./mermaid-rendering.ts";\n',
        1,
    )

tree_re = re.compile(
    r'  if \(data\.tree\.root\.children\.length === 0\) \{.*?\n  \}\n\n  const recentFacts',
    re.S,
)
tree_block = '''  if (data.tree.root.children.length === 0) {
    lines.push(color(theme, "success", "idle"));
  } else {
    lines.push(heading(theme, "Execution sequence"));
    try {
      lines.push(...renderRunTreeSequence(data.tree, { expanded: data.expanded }).split("\\n"));
    } catch {
      data.tree.root.children.forEach((child, index) => {
        appendNode(
          lines,
          child,
          "",
          index === data.tree.root.children.length - 1,
          theme,
          data.expanded,
        );
      });
    }
  }

  const recentFacts'''
monitor, count = tree_re.subn(lambda _: tree_block, monitor, count=1)
if count != 1:
    raise SystemExit("status tree renderer not found")
monitor_path.write_text(monitor)
