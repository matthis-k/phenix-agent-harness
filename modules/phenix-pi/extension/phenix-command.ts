export const PHENIX_SUBCOMMANDS = [
  { value: "status", label: "status — Open the compact live dashboard" },
  { value: "logs", label: "logs — Inspect or export structured diagnostics" },
  { value: "facts", label: "facts — Toggle or export the full fact history" },
  { value: "tasks", label: "tasks — Show the task projection" },
  { value: "catalog", label: "catalog — List invokable definitions" },
  { value: "integrations", label: "integrations — Show integration health" },
] as const;

export const PHENIX_USAGE = `/phenix ${PHENIX_SUBCOMMANDS.map((item) => item.value).join("|")}`;
export const PHENIX_STATUS_USAGE = "/phenix status [off|--once|--json|--expanded]";
export const PHENIX_FACTS_USAGE =
  "/phenix facts [off|--once|--json|--clipboard [command]|--file <file>]";

export function completePhenixSubcommands(prefix: string) {
  const normalized = prefix.trimStart().toLowerCase();
  if (/\s/.test(normalized)) return null;

  const matches = PHENIX_SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
  return matches.length > 0
    ? matches.map((item) => ({ value: item.value, label: item.label }))
    : null;
}
