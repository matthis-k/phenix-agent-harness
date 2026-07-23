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

const loaders: Readonly<Record<IntegrationId, () => Promise<ExtensionModule>>> = {
  hypa: () => import("@hypabolic/pi-hypa/extensions/index.ts") as Promise<ExtensionModule>,
  lsp: () => import("pi-lsp/extensions/pi-lsp/index.ts") as Promise<ExtensionModule>,
  mcp: () => import("pi-mcp-adapter/index.ts") as Promise<ExtensionModule>,
  context: () => import("pi-context-tools/extensions/index.ts") as Promise<ExtensionModule>,
  web: () => import("@juicesharp/rpiv-web-tools/index.ts") as Promise<ExtensionModule>,
};

export async function loadPiIntegrations(pi: ExtensionAPI): Promise<readonly IntegrationStatus[]> {
  const statuses: IntegrationStatus[] = [];
  for (const id of Object.keys(loaders) as IntegrationId[]) {
    try {
      const extension = await loaders[id]();
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
