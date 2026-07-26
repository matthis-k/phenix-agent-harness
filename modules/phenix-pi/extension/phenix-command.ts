export const PHENIX_SUBCOMMANDS = [
  { value: "ui", label: "ui — Open the full-screen Status, Runs, Facts, and Catalog interface" },
  { value: "status", label: "status — Print a compact status snapshot" },
  { value: "health", label: "health — Inspect runtime and configuration health" },
  { value: "logs", label: "logs — Inspect or export structured diagnostics" },
  { value: "facts", label: "facts — Print or export the complete fact history" },
  { value: "tasks", label: "tasks — Show the task projection" },
  { value: "catalog", label: "catalog — Open the Catalog UI view" },
  { value: "integrations", label: "integrations — Show integration health" },
] as const;

export const PHENIX_USAGE = `/phenix ${PHENIX_SUBCOMMANDS.map((item) => item.value).join("|")}`;
export const PHENIX_UI_USAGE = "/phenix ui [status|runs [run-id]|facts|catalog [definition-id]]";
export const PHENIX_STATUS_USAGE = "/phenix status [--json|--expanded]";
export const PHENIX_HEALTH_USAGE =
  "/phenix health [integrations|models|definitions|runtime|storage] [--json]";
export const PHENIX_FACTS_USAGE = "/phenix facts [--json|--clipboard [command]|--file <file>]";

export function completePhenixSubcommands(prefix: string) {
  const normalized = prefix.trimStart().toLowerCase();
  if (/\s/.test(normalized)) return null;

  const matches = PHENIX_SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
  return matches.length > 0
    ? matches.map((item) => ({ value: item.value, label: item.label }))
    : null;
}
