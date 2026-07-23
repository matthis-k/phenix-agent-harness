from pathlib import Path


def update(path: str, transform) -> None:
    file = Path(path)
    source = file.read_text()
    updated = transform(source)
    if updated != source:
        file.write_text(updated)


def replace_exact(source: str, old: str, new: str, expected: int = 1) -> str:
    count = source.count(old)
    if count == 0 and new in source:
        return source
    if count != expected:
        raise SystemExit(f"expected {expected} matches, found {count}: {old[:120]!r}")
    return source.replace(old, new)


def correct_executor(source: str) -> str:
    source = replace_exact(
        source,
        "const maxTurns = live.definition.limits.maxTurns;",
        "const maxTurns = live.limits.maxTurns;",
    )
    command_provider_old = '''        await this.controller.fail(command.runId, {
          code: "provider_failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });'''
    command_provider_new = '''        await this.controller.fail(
          command.runId,
          automaticFailure(
            "provider_failed",
            error instanceof Error ? error.message : String(error),
            "external_failure",
            true,
          ),
        );'''
    source = replace_exact(source, command_provider_old, command_provider_new, expected=2)
    source = replace_exact(
        source,
        '''      await this.controller.fail(command.runId, {
        code: "output_missing",
        message: `Agent settled without phenix_return after ${previousCycle.number} cycle(s)`,
        retryable: false,
      });''',
        '''      const maxRepairAttempts = compiled.limits.maxRepairAttempts ?? 0;
      await this.controller.fail(
        command.runId,
        automaticFailure(
          "output_missing",
          `Agent settled without phenix_return or phenix_fail after ${previousCycle.number} cycle(s)`,
          "deadlock",
          true,
          { maxRepairAttempts: Math.min(10, maxRepairAttempts + 1) },
        ),
      );''',
    )
    source = replace_exact(
        source,
        '        "Resume this run and submit the required typed output with phenix_return.",',
        '        "Resume this run and call phenix_return with the typed output, or phenix_fail with a short report if the run remains blocked.",',
    )
    source = replace_exact(
        source,
        '''      await this.controller.fail(runId, {
        code: "provider_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });''',
        '''      await this.controller.fail(
        runId,
        automaticFailure(
          "provider_failed",
          error instanceof Error ? error.message : String(error),
          "external_failure",
          true,
        ),
      );''',
    )
    return source


def correct_execution(source: str) -> str:
    source = replace_exact(
        source,
        '''  if (kind !== "agent" && addTools.length > 0) {
    throw new Error(`Only agent retries may add tools`);
  }''',
        '''  if (kind !== "agent" && (addTools.length > 0 || options.limits !== undefined)) {
    throw new Error(`Only agent retries may override tools or limits`);
  }''',
    )
    return source


def correct_runtime(source: str) -> str:
    source = replace_exact(
        source,
        '''    if (event.type === "run.created" && retryOf) {
      await rootNotifier?.(
        `Recovery run ${run.id} started for failed run ${retryOf}. The original outcome remains immutable.`,
      );
      return;
    }''',
        '''    if (event.type === "run.created" && retryOf) {
      const original = store.projection.runs.get(retryOf);
      await rootNotifier?.(
        summarizeRetryStart(run, original),
      );
      return;
    }''',
    )
    source = replace_exact(
        source,
        '''          readonly retryable: boolean;
          readonly causeRunId?: RunId;
        };''',
        '''          readonly retryable: boolean;
          readonly causeRunId?: RunId;
          readonly details?: {
            readonly category?: string;
            readonly requestedTools?: readonly string[];
            readonly suggestedLimits?: unknown;
          };
        };''',
    )
    source = replace_exact(
        source,
        '''    const cause = value.failure.causeRunId ? ` Cause: ${value.failure.causeRunId}.` : "";
    const recovery = value.failure.retryable
      ? " A bounded retry may be appropriate after inspecting the report."
      : " The failure is marked non-retryable; choose another route or ask the user before forcing recovery.";
    return `${prefix} failed [${value.failure.code}]: ${value.failure.message}.${cause}${recovery}`;''',
        '''    const cause = value.failure.causeRunId ? ` Cause: ${value.failure.causeRunId}.` : "";
    const category = value.failure.details?.category
      ? ` Category: ${value.failure.details.category}.`
      : "";
    const requestedTools = value.failure.details?.requestedTools?.length
      ? ` Requested tools: ${value.failure.details.requestedTools.join(", ")}.`
      : "";
    const suggestedLimits = value.failure.details?.suggestedLimits
      ? ` Suggested limits: ${JSON.stringify(value.failure.details.suggestedLimits)}.`
      : "";
    const recovery = value.failure.retryable
      ? " A bounded retry may be appropriate after inspecting the report."
      : " The failure is marked non-retryable; choose another route or ask the user before forcing recovery.";
    const punctuation = /[.!?]$/.test(value.failure.message) ? "" : ".";
    return `${prefix} failed [${value.failure.code}]: ${value.failure.message}${punctuation}${cause}${category}${requestedTools}${suggestedLimits}${recovery}`;''',
    )
    marker = "function summarizeTerminal(outcome: unknown, runId: RunId, retryOf?: RunId): string {"
    helper = '''function summarizeRetryStart(
  retry: { readonly id: RunId; readonly compiled: { readonly tools: readonly string[]; readonly limits: object } },
  original:
    | { readonly id: RunId; readonly compiled: { readonly tools: readonly string[]; readonly limits: object } }
    | undefined,
): string {
  const originalTools = new Set(original?.compiled.tools ?? []);
  const addedTools = retry.compiled.tools.filter((tool) => !originalTools.has(tool));
  const changedLimits = original
    ? Object.fromEntries(
        Object.entries(retry.compiled.limits).filter(
          ([key, value]) =>
            value !== (original.compiled.limits as Readonly<Record<string, unknown>>)[key],
        ),
      )
    : retry.compiled.limits;
  const tools = addedTools.length > 0 ? ` Added tools: ${addedTools.join(", ")}.` : "";
  const limits =
    Object.keys(changedLimits).length > 0
      ? ` Changed limits: ${JSON.stringify(changedLimits)}.`
      : "";
  return `Recovery run ${retry.id} started for failed run ${original?.id ?? "unknown"}.${tools}${limits} The original outcome remains immutable.`;
}

'''
    if helper not in source:
        if marker not in source:
            raise SystemExit("runtime summary marker missing")
        source = source.replace(marker, helper + marker)
    return source


def correct_root_prompt(source: str) -> str:
    return source.replace(
        "recovery may add read/search tools or bash, never mutation permissions to a read-only task.",
        "recovery may add read/search tools or explicitly escalate to bash, but never add edit/write directly to a read-only task; report every escalation to the user.",
    )


update("modules/phenix-pi/application/agent-executor.ts", correct_executor)
update("modules/phenix-pi/application/execution-facade.ts", correct_execution)
update("modules/phenix-pi/composition/create-phenix-runtime.ts", correct_runtime)
update("modules/phenix-pi/extension/root-extension.ts", correct_root_prompt)
