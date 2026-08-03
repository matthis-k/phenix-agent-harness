export const PHENIX_SUBCOMMANDS = [
  { value: "ui", label: "ui — Open the full-screen Status, Runs, Facts, and Catalog interface" },
  { value: "status", label: "status — Print a compact status snapshot" },
  { value: "health", label: "health — Inspect runtime and configuration health" },
  { value: "logs", label: "logs — Inspect or export structured diagnostics" },
  { value: "facts", label: "facts — Print or export the complete fact history" },
  { value: "objectives", label: "objectives — Show the objective and sub-objective tree" },
  { value: "integrations", label: "integrations — Show integration health" },
] as const;

export type PhenixSubcommand = (typeof PHENIX_SUBCOMMANDS)[number]["value"];
type ExplicitPhenixSubcommand = Exclude<PhenixSubcommand, "ui">;

type InvocationOptions = {
  readonly rawOptions: string;
  readonly options: readonly string[];
};

export type PhenixInvocation =
  | (InvocationOptions & {
      readonly action: "ui";
      readonly implicitUi: boolean;
    })
  | (InvocationOptions & {
      readonly action: ExplicitPhenixSubcommand;
      readonly implicitUi: false;
    })
  | (InvocationOptions & {
      readonly action: "invalid";
      readonly requestedAction: string;
      readonly implicitUi: false;
    });

const EXPLICIT_SUBCOMMANDS = new Set<string>(
  PHENIX_SUBCOMMANDS.filter(({ value }) => value !== "ui").map(({ value }) => value),
);

export const PHENIX_USAGE = `/phenix [${PHENIX_SUBCOMMANDS.map((item) => item.value).join("|")}]`;
export const PHENIX_UI_USAGE = "/phenix ui [status|runs [run-id]|facts|catalog [definition-id]]";
export const PHENIX_STATUS_USAGE = "/phenix status [--json|--expanded]";
export const PHENIX_HEALTH_USAGE =
  "/phenix health [integrations|models|definitions|runtime|storage] [--json]";
export const PHENIX_FACTS_USAGE = "/phenix facts [--json|--clipboard [command]|--file <file>]";

/** Parse arbitrary command text into a closed invocation union. */
export function parsePhenixInvocation(args: string): PhenixInvocation {
  const trimmed = args.trim();
  const separator = trimmed.search(/\s/);
  const actionToken = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const rawOptions = separator === -1 ? "" : trimmed.slice(separator).trim();
  const options = rawOptions
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => value.toLowerCase());

  if (!actionToken) {
    return { action: "ui", rawOptions, options, implicitUi: true };
  }

  const requestedAction = actionToken.toLowerCase();
  if (requestedAction === "ui") {
    return { action: "ui", rawOptions, options, implicitUi: false };
  }
  if (isExplicitPhenixSubcommand(requestedAction)) {
    return { action: requestedAction, rawOptions, options, implicitUi: false };
  }

  return {
    action: "invalid",
    requestedAction,
    rawOptions,
    options,
    implicitUi: false,
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

function isExplicitPhenixSubcommand(value: string): value is ExplicitPhenixSubcommand {
  return EXPLICIT_SUBCOMMANDS.has(value);
}
