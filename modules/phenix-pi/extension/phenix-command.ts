export const PHENIX_SUBCOMMANDS = [
  { value: "status", label: "status — Show runtime status" },
  { value: "runs", label: "runs — Toggle the live run tree" },
  { value: "facts", label: "facts — Toggle the live fact history" },
  { value: "tasks", label: "tasks — Show the task projection" },
  { value: "catalog", label: "catalog — List invokable definitions" },
  { value: "integrations", label: "integrations — Show integration health" },
] as const;

export const PHENIX_USAGE = `/phenix ${PHENIX_SUBCOMMANDS.map((item) => item.value).join("|")}`;

export function completePhenixSubcommands(prefix: string) {
  const normalized = prefix.trimStart().toLowerCase();
  if (/\s/.test(normalized)) return null;

  const matches = PHENIX_SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
  return matches.length > 0
    ? matches.map((item) => ({ value: item.value, label: item.label }))
    : null;
}
