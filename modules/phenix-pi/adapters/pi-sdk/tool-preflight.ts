import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import type { AgentTool } from "../../ports/agent-session-backend.ts";

export type ToolAvailabilityReason = "not_registered" | "executable_not_found";

export interface ToolAvailabilityIssue {
  readonly tool: string;
  readonly reason: ToolAvailabilityReason;
  readonly executable?: string;
  readonly searchedPath?: string;
}

const PI_BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const TOOL_EXECUTABLES: Readonly<Record<string, string>> = {
  bash: "bash",
  nix_shell: "nix",
};

export function inspectToolAvailability(input: {
  readonly tools: readonly string[];
  readonly customTools: readonly Pick<AgentTool, "name">[];
  readonly path?: string;
  readonly checkExecutables?: boolean;
}): readonly ToolAvailabilityIssue[] {
  const custom = new Set(input.customTools.map((tool) => tool.name));
  // nix_shell is constructed by the Pi adapter when requested rather than by AgentToolFactory.
  custom.add("nix_shell");
  const path = input.path ?? process.env.PATH ?? "";
  const issues: ToolAvailabilityIssue[] = [];

  for (const tool of new Set(input.tools)) {
    if (!PI_BUILTIN_TOOLS.has(tool) && !custom.has(tool)) {
      issues.push({ tool, reason: "not_registered" });
      continue;
    }
    const executable = TOOL_EXECUTABLES[tool];
    if (input.checkExecutables !== false && executable && !resolveExecutable(executable, path)) {
      issues.push({
        tool,
        reason: "executable_not_found",
        executable,
        searchedPath: path,
      });
    }
  }
  return issues;
}

export function formatToolAvailabilityIssues(
  definitionId: string,
  issues: readonly ToolAvailabilityIssue[],
): string {
  const descriptions = issues.map((issue) => {
    if (issue.reason === "not_registered") return `${issue.tool}: tool is not registered`;
    return `${issue.tool}: executable ${issue.executable} was not found in PATH`;
  });
  return `Tools required by ${definitionId} are unavailable: ${descriptions.join("; ")}`;
}

function resolveExecutable(executable: string, path: string): string | undefined {
  if (isAbsolute(executable)) return isExecutable(executable) ? executable : undefined;
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, executable);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
