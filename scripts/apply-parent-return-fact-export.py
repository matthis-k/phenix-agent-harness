from pathlib import Path


def replace(path_name: str, old: str, new: str) -> None:
    path = Path(path_name)
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"Expected block not found in {path_name}")
    path.write_text(text.replace(old, new, 1))


replace(
    "modules/phenix-pi/application/execution-facade.ts",
    '''  async await<O>(runId: RunId, signal?: AbortSignal): Promise<Outcome<O>> {
    const current = this.store.projection.requireRun(runId);
    if (current.outcome) return current.outcome as Outcome<O>;
    if (signal?.aborted) throw abortError(signal);

    return new Promise<Outcome<O>>((resolve, reject) => {
      let unsubscribe: () => void = () => undefined;
      const onAbort = (): void => {
        unsubscribe();
        reject(abortError(signal));
      };
      unsubscribe = this.store.events.subscribe((event) => {
        if (event.runId !== runId || !isTerminalEvent(event.type)) return;
        const outcome = this.store.projection.requireRun(runId).outcome;
        if (!outcome) return;
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve(outcome as Outcome<O>);
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }''',
    '''  async await<O>(runId: RunId, signal?: AbortSignal): Promise<Outcome<O>> {
    if (signal?.aborted) throw abortError(signal);

    return new Promise<Outcome<O>>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const finish = (outcome: Outcome<O>): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve(outcome);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(abortError(signal));
      };
      unsubscribe = this.store.events.subscribe((event) => {
        if (event.runId !== runId || !isTerminalEvent(event.type)) return;
        const outcome = this.store.projection.requireRun(runId).outcome;
        if (outcome) finish(outcome as Outcome<O>);
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      const current = this.store.projection.requireRun(runId);
      if (current.outcome) {
        finish(current.outcome as Outcome<O>);
      } else if (signal?.aborted) {
        onAbort();
      }
    });
  }''',
)

replace(
    "modules/phenix-pi/extension/root-extension.ts",
    '''import { completePhenixSubcommands, PHENIX_USAGE } from "./phenix-command.ts";
import { RunMonitor, type RunMonitorMode } from "./run-monitor.ts";''',
    '''import { copyFactHistory, parseFactsCommand, writeFactHistory } from "./fact-export.ts";
import {
  completePhenixSubcommands,
  PHENIX_FACTS_USAGE,
  PHENIX_USAGE,
} from "./phenix-command.ts";
import { RunMonitor } from "./run-monitor.ts";''',
)

replace(
    "modules/phenix-pi/extension/root-extension.ts",
    '''      const tokens = args.trim().split(/\\s+/).filter(Boolean);
      const action = (tokens.shift() ?? "status").toLowerCase();
      const options = tokens.map((value) => value.toLowerCase());''',
    '''      const trimmed = args.trim();
      const separator = trimmed.search(/\\s/);
      const actionToken = separator === -1 ? trimmed : trimmed.slice(0, separator);
      const rawOptions = separator === -1 ? "" : trimmed.slice(separator).trim();
      const action = (actionToken || "status").toLowerCase();
      const options = rawOptions
        .split(/\\s+/)
        .filter(Boolean)
        .map((value) => value.toLowerCase());''',
)

replace(
    "modules/phenix-pi/extension/root-extension.ts",
    '''      if (action === "runs" || action === "facts") {
        const activeMonitor = monitor ?? new RunMonitor(ctx, activeRuntime, activeRoot);
        monitor = activeMonitor;
        const mode = action as Exclude<RunMonitorMode, "hidden">;
        const option = options[0];
        if (options.length > 1 || (option && !["off", "--once", "--json"].includes(option))) {
          ctx.ui.notify(`Usage: /phenix ${action} [off|--once|--json]`, "warning");
          return;
        }
        if (option === "off") {
          activeMonitor.hide();
          return;
        }
        if (option === "--once") {
          ctx.ui.notify(limit(await activeMonitor.once(mode)), "info");
          return;
        }
        if (option === "--json") {
          ctx.ui.notify(limit(await activeMonitor.json(mode)), "info");
          return;
        }
        await activeMonitor.show(mode);
        return;
      }''',
    '''      if (action === "facts") {
        const activeMonitor = monitor ?? new RunMonitor(ctx, activeRuntime, activeRoot);
        monitor = activeMonitor;
        const factsAction = parseFactsCommand(rawOptions);
        if (!factsAction) {
          ctx.ui.notify(`Usage: ${PHENIX_FACTS_USAGE}`, "warning");
          return;
        }
        if (factsAction.kind === "live") {
          await activeMonitor.show("facts");
          return;
        }
        if (factsAction.kind === "off") {
          activeMonitor.hide();
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
            ctx.ui.notify(
              `Copied ${exported.count} facts using: ${factsAction.command}`,
              "info",
            );
            return;
          }
          const file = await writeFactHistory(exported.text, factsAction.file, ctx.cwd);
          ctx.ui.notify(`Wrote ${exported.count} facts to ${file}`, "info");
        } catch (error) {
          ctx.ui.notify(`Fact export failed: ${errorMessage(error)}`, "warning");
        }
        return;
      }
      if (action === "runs") {
        const activeMonitor = monitor ?? new RunMonitor(ctx, activeRuntime, activeRoot);
        monitor = activeMonitor;
        const option = options[0];
        if (options.length > 1 || (option && !["off", "--once", "--json"].includes(option))) {
          ctx.ui.notify("Usage: /phenix runs [off|--once|--json]", "warning");
          return;
        }
        if (option === "off") {
          activeMonitor.hide();
          return;
        }
        if (option === "--once") {
          ctx.ui.notify(limit(await activeMonitor.once("runs")), "info");
          return;
        }
        if (option === "--json") {
          ctx.ui.notify(limit(await activeMonitor.json("runs")), "info");
          return;
        }
        await activeMonitor.show("runs");
        return;
      }''',
)

replace(
    "modules/phenix-pi/extension/root-extension.ts",
    "        activeRuntime.queries.facts(activeRoot, 1_000),",
    "        activeRuntime.queries.facts(activeRoot),",
)

replace(
    "modules/phenix-pi/extension/root-extension.ts",
    '''function limit(value: string): string {
  return value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\\n… truncated`;
}''',
    '''function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function limit(value: string): string {
  return value.length <= 8_000 ? value : `${value.slice(0, 8_000)}\\n… truncated`;
}''',
)

for temporary in [
    ".github/workflows/apply-parent-return-fact-export.yml",
    ".github/workflows/run-parent-return-fact-export.yml",
    "scripts/apply-parent-return-fact-export.py",
]:
    Path(temporary).unlink(missing_ok=True)
