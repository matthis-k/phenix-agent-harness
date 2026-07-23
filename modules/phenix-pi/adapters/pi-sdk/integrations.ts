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
  return statuses
    .map((status) =>
      status.state === "loaded" ? `${status.id}=loaded` : `${status.id}=failed(${status.error})`,
    )
    .join(", ");
}
