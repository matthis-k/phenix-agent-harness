export type IntegrationId = "hypa" | "lsp" | "mcp" | "context" | "web";

export interface IntegrationStatus {
  readonly id: IntegrationId;
  readonly state: "loaded" | "failed";
  readonly error?: string;
}
