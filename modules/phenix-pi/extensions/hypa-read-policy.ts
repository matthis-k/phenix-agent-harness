export function hasHypaReadTool(tools: ReadonlyArray<{ readonly name: string }>): boolean {
  return tools.some((tool) => tool.name === "hypa_read");
}

export function ensureReadActive(activeTools: readonly string[]): string[] {
  return activeTools.includes("read") ? [...activeTools] : [...activeTools, "read"];
}
