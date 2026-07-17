type ToolName = { readonly name: string };

export function hasHypaReadTool(tools: readonly ToolName[]): boolean {
  return tools.some((tool) => tool.name === "hypa_read");
}

export function createDeferredHypaReadRegistration(
  getTools: () => readonly ToolName[],
  registerReadTool: () => void,
): () => void {
  let registered = false;

  return () => {
    if (registered || !hasHypaReadTool(getTools())) return;

    registerReadTool();
    registered = true;
  };
}

export function ensureReadActive(activeTools: readonly string[]): string[] {
  return activeTools.includes("read") ? [...activeTools] : [...activeTools, "read"];
}
