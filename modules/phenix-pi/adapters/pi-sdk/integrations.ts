import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type IntegrationId = "hypa" | "lsp" | "mcp" | "context" | "web";

export interface IntegrationStatus {
  readonly id: IntegrationId;
  readonly state: "loaded" | "failed";
  readonly error?: string;
}

type ExtensionModule = {
  readonly default: (pi: ExtensionAPI) => void | Promise<void>;
};

const INTEGRATION_LABELS: Readonly<Record<IntegrationId, string>> = {
  hypa: "Hypa",
  lsp: "Language servers",
  mcp: "MCP adapter",
  context: "Context tools",
  web: "Web tools",
};

const specifiers: Readonly<Record<IntegrationId, string>> = {
  hypa: "@hypabolic/pi-hypa/extensions/index.ts",
  lsp: "pi-lsp/extensions/pi-lsp/index.ts",
  mcp: "pi-mcp-adapter/index.ts",
  context: "pi-context-tools/extensions/index.ts",
  web: "@juicesharp/rpiv-web-tools/index.ts",
};

// Keep optional package source outside the harness TypeScript program. These
// extensions are loaded and validated by Pi at runtime; a broken optional
// package must be reported as an integration failure, not break the core build.
const runtimeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<ExtensionModule>;

export async function loadPiIntegrations(pi: ExtensionAPI): Promise<readonly IntegrationStatus[]> {
  const statuses: IntegrationStatus[] = [];
  for (const id of Object.keys(specifiers) as IntegrationId[]) {
    try {
      const extension = await runtimeImport(specifiers[id]);
      await extension.default(pi);
      statuses.push({ id, state: "loaded" });
    } catch (error) {
      statuses.push({
        id,
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return statuses;
}

export function summarizeIntegrations(statuses: readonly IntegrationStatus[]): string {
  const loaded = statuses.filter((status) => status.state === "loaded").length;
  const failed = statuses.filter((status) => status.state === "failed").map((status) => status.id);
  return failed.length === 0
    ? `${loaded}/${statuses.length} loaded`
    : `${loaded}/${statuses.length} loaded; failed: ${failed.join(", ")}`;
}

export function formatIntegrationReport(statuses: readonly IntegrationStatus[]): string {
  const loaded = statuses.filter((status) => status.state === "loaded").length;
  const lines = [`Integrations: ${loaded}/${statuses.length} loaded`];

  for (const status of statuses) {
    const label = `${INTEGRATION_LABELS[status.id]} (${status.id})`;
    if (status.state === "loaded") {
      lines.push(`✓ ${label} — loaded`);
      continue;
    }

    lines.push(`✗ ${label} — failed`);
    if (status.error) lines.push(`  ${singleLine(status.error)}`);
  }

  return lines.join("\n");
}

function singleLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 500)}…`;
}
