export const PHENIX_SUBCOMMANDS = [
  { value: "ui", label: "ui — Open the full-screen Status, Runs, Facts, and Catalog interface" },
  { value: "status", label: "status — Print a compact status snapshot" },
  { value: "health", label: "health — Inspect runtime and configuration health" },
  { value: "logs", label: "logs — Inspect or export structured diagnostics" },
  { value: "facts", label: "facts — Print or export the complete fact history" },
  { value: "tasks", label: "tasks — Show the task projection" },
  { value: "integrations", label: "integrations — Show integration health" },
] as const;

export interface PhenixInvocation {
  readonly action: string;
  readonly rawOptions: string;
  readonly options: readonly string[];
  readonly implicitUi: boolean;
}

export const PHENIX_USAGE = `/phenix [${PHENIX_SUBCOMMANDS.map((item) => item.value).join("|")}]`;
export const PHENIX_UI_USAGE = "/phenix ui [status|runs [run-id]|facts|catalog [definition-id]]";
export const PHENIX_STATUS_USAGE = "/phenix status [--json|--expanded]";
export const PHENIX_HEALTH_USAGE =
  "/phenix health [integrations|models|definitions|runtime|storage] [--json]";
export const PHENIX_FACTS_USAGE = "/phenix facts [--json|--clipboard [command]|--file <file>]";

export function parsePhenixInvocation(args: string): PhenixInvocation {
  const trimmed = args.trim();
  const separator = trimmed.search(/\s/);
  const actionToken = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const rawOptions = separator === -1 ? "" : trimmed.slice(separator).trim();
  return {
    action: (actionToken || "ui").toLowerCase(),
    rawOptions,
    options: rawOptions
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => value.toLowerCase()),
    implicitUi: actionToken.length === 0,
  };
}

export function completePhenixSubcommands(prefix: string) {
  const normalized = prefix.trimStart().toLowerCase();
  if (/\s/.test(normalized)) return null;

  const matches = PHENIX_SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
  return matches.length > 0
    ? matches.map((item) => ({ value: item.value, label: item.label }))
    : null;
}
