from pathlib import Path

path = Path("modules/phenix-pi/extension/root-extension.ts")
text = path.read_text()

old_import = 'import { CatalogBrowser } from "./catalog-browser.ts";\n'
new_import = (
    'import {\n'
    '  loadPhenixUiSnapshot,\n'
    '  parsePhenixUiTarget,\n'
    '  PhenixUi,\n'
    '  type PhenixUiTarget,\n'
    '} from "./phenix-ui.ts";\n'
)
assert old_import in text
text = text.replace(old_import, new_import, 1)

usage_import = "  PHENIX_STATUS_USAGE,\n  PHENIX_USAGE,\n"
assert usage_import in text
text = text.replace(
    usage_import,
    "  PHENIX_STATUS_USAGE,\n  PHENIX_UI_USAGE,\n  PHENIX_USAGE,\n",
    1,
)

text = text.replace("      void monitor?.refresh();\n", "", 1)

catalog_start = text.index('      if (action === "catalog") {')
logs_start = text.index('      if (action === "logs") {', catalog_start)
catalog_block = '''      if (action === "ui") {
        const target = parsePhenixUiTarget(rawOptions);
        if (!target) {
          ctx.ui.notify(`Usage: ${PHENIX_UI_USAGE}`, "warning");
          return;
        }
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/phenix ui requires interactive TUI mode.", "warning");
          return;
        }
        await openPhenixUi(
          ctx,
          activeRuntime,
          activeRoot,
          summarizeIntegrations(integrationStatuses),
          target,
        );
        return;
      }
      if (action === "catalog") {
        if (ctx.mode === "tui") {
          await openPhenixUi(
            ctx,
            activeRuntime,
            activeRoot,
            summarizeIntegrations(integrationStatuses),
            rawOptions.trim()
              ? { view: "catalog", selector: rawOptions.trim() }
              : { view: "catalog" },
          );
          return;
        }
        const available = await activeRuntime.catalog.listAvailable(activeRoot);
        const query = rawOptions.trim().toLowerCase();
        const matches = query
          ? available.filter((definition) => {
              const id = String(definition.id).toLowerCase();
              const shortId = id.replace(/^(?:agent|workflow)\\./, "");
              return id === query || shortId === query || definition.title.toLowerCase() === query;
            })
          : [];
        if (query && matches.length !== 1) {
          ctx.ui.notify(
            matches.length === 0
              ? `Catalog definition not found: ${rawOptions}`
              : `Catalog selector is ambiguous: ${matches.map((item) => item.id).join(", ")}`,
            "warning",
          );
          return;
        }
        const match = matches[0];
        if (match) {
          const definition = activeRuntime.catalog.get(definitionRef(match.id)) as AnyDefinition;
          ctx.ui.notify(limit(renderCatalogDefinition(definition)), "info");
        } else {
          ctx.ui.notify(
            available.map((definition) => `${definition.id} — ${definition.title}`).join("\\n"),
            "info",
          );
        }
        return;
      }
'''
text = text[:catalog_start] + catalog_block + text[logs_start:]

facts_start = text.index('      if (action === "facts") {')
tasks_start = text.index('      if (action === "tasks") {', facts_start)
facts_block = '''      if (action === "facts") {
        const activeMonitor =
          monitor ??
          new RunMonitor(ctx, activeRuntime, activeRoot, {
            integrations: summarizeIntegrations(integrationStatuses),
            integrationsFailed: integrationStatuses.some((status) => status.state === "failed"),
          });
        monitor = activeMonitor;
        const factsAction = parseFactsCommand(rawOptions);
        if (!factsAction) {
          ctx.ui.notify(`Usage: ${PHENIX_FACTS_USAGE}`, "warning");
          return;
        }
        if (factsAction.kind === "once") {
          ctx.ui.notify(limit(await activeMonitor.once("facts")), "info");
          return;
        }
        if (factsAction.kind === "json") {
          ctx.ui.notify(limit(await activeMonitor.json("facts")), "info");
          return;
        }
        try {
          const exported = await activeMonitor.exportFacts();
          if (factsAction.kind === "clipboard") {
            await copyFactHistory(exported.text, factsAction.command, ctx.cwd);
            ctx.ui.notify(`Copied ${exported.count} facts using: ${factsAction.command}`, "info");
            return;
          }
          const file = await writeFactHistory(exported.text, factsAction.file, ctx.cwd);
          ctx.ui.notify(`Wrote ${exported.count} facts to ${file}`, "info");
        } catch (error) {
          ctx.ui.notify(`Fact export failed: ${errorMessage(error)}`, "warning");
        }
        return;
      }
'''
text = text[:facts_start] + facts_block + text[tasks_start:]

status_start = text.index('      if (action !== "status") {')
handler_end = text.index('    },\n  });\n}', status_start)
status_block = '''      if (action !== "status") {
        ctx.ui.notify(`Usage: ${PHENIX_USAGE}`, "warning");
        return;
      }
      const activeMonitor =
        monitor ??
        new RunMonitor(ctx, activeRuntime, activeRoot, {
          integrations: summarizeIntegrations(integrationStatuses),
          integrationsFailed: integrationStatuses.some((status) => status.state === "failed"),
        });
      monitor = activeMonitor;
      const allowed = new Set(["--json", "--expanded"]);
      if (options.some((option) => !allowed.has(option))) {
        ctx.ui.notify(`Usage: ${PHENIX_STATUS_USAGE}`, "warning");
        return;
      }
      if (options.includes("--json")) {
        ctx.ui.notify(limit(await activeMonitor.json("status")), "info");
        return;
      }
      ctx.ui.notify(
        limit(await activeMonitor.once("status", { expanded: options.includes("--expanded") })),
        "info",
      );
'''
text = text[:status_start] + status_block + text[handler_end:]

helper_marker = "\nfunction registerMermaidTool(pi: ExtensionAPI): void {"
assert helper_marker in text
helper = '''
async function openPhenixUi(
  ctx: ExtensionContext,
  runtime: PhenixRuntime,
  rootRunId: RunId,
  integrations: string,
  initial: PhenixUiTarget,
): Promise<void> {
  const load = () => loadPhenixUiSnapshot(runtime, rootRunId, integrations);
  const snapshot = await load();
  await ctx.ui.custom(
    (tui, theme, _keybindings, done) =>
      new PhenixUi({
        tui,
        theme,
        initial,
        snapshot,
        load,
        subscribe: (listener) => {
          const unsubscribeEvents = runtime.events.subscribe(listener);
          const unsubscribeDiagnostics = runtime.diagnostics.subscribe(listener);
          return () => {
            unsubscribeEvents();
            unsubscribeDiagnostics();
          };
        },
        onClose: () => done(undefined),
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "top-left",
        margin: 0,
      },
    },
  );
}
'''
text = text.replace(helper_marker, helper + helper_marker, 1)
path.write_text(text)
