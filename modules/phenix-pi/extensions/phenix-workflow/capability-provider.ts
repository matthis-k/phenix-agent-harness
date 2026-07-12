/**
 * Agent capability provider interface and implementation.
 *
 * Discovers Phenix agents from the bundled agents directory.
 */

// ── Discovered agent definition ─────────────────────────────────────────────

export interface DiscoveredAgentDefinition {
  readonly runtimeName: string;
  readonly localName: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly source:
    | "builtin"
    | "package"
    | "user"
    | "project"
    | "generated";
  readonly filePath?: string;
  readonly disabled: boolean;
}

// ── Agent discovery helper interface ────────────────────────────────────────

export interface AgentDiscoveryHelper {
  discoverAgents(input: {
    readonly cwd: string;
    readonly scope: "both";
  }): Promise<readonly DiscoveredAgentDefinition[]>;
}

// ── Builtin discovery implementation ────────────────────────────────────────

/**
 * Discover agents from the bundled agents directory.
 *
 * Agents are markdown files under the package's agents/ directory.
 * No external subagents config is consulted.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

export class BuiltinAgentDiscovery implements AgentDiscoveryHelper {
  private readonly agentsDir: string;

  constructor() {
    // Resolve the agents directory relative to this module
    this.agentsDir = fileURLToPath(
      new URL("../../agents", import.meta.url),
    );
  }

  async discoverAgents(input: {
    readonly cwd: string;
    readonly scope: "both";
  }): Promise<readonly DiscoveredAgentDefinition[]> {
    const results: DiscoveredAgentDefinition[] = [];

    // Discover agent markdown files from the agents directory
    if (existsSync(this.agentsDir)) {
      try {
        const files = readdirSync(this.agentsDir);
        for (const file of files) {
          if (!file.endsWith(".md")) continue;

          const name = basename(file, ".md");
          const runtimeName = name === "base" ? "phenix.base" : `phenix.${name}`;
          const filePath = join(this.agentsDir, file);

          let description = "";
          let disabled = false;

          try {
            const content = readFileSync(filePath, "utf-8");
            // Extract frontmatter if present
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const fm = fmMatch[1];
              const descMatch = fm.match(/description:\s*(.+)/);
              if (descMatch) description = descMatch[1].trim();
              if (fm.includes("disabled: true") || fm.includes("disable-model-invocation: true")) {
                // disable-model-invocation is for skills, not agent definitions
                // Agents use "disabled: true" in frontmatter
                if (fm.includes("disabled: true")) {
                  disabled = true;
                }
              }
            }
          } catch {
            // If we can't read the file, treat as unavailable
            continue;
          }

          // Extract tools from the markdown content
          const tools = this.extractTools(filePath);

          results.push({
            runtimeName,
            localName: name,
            description: description || `Phenix ${name} agent`,
            tools,
            source: "builtin",
            filePath,
            disabled,
          });
        }
      } catch {
        // Agents directory doesn't exist or can't be read
      }
    }

    return results;
  }

  private extractTools(_filePath: string): readonly string[] {
    // Tools are determined by the role preset, not the markdown file
    // Return the default tool set based on known role
    return [];
  }
}

// ── Singleton helper ────────────────────────────────────────────────────────

let _discoveryHelper: AgentDiscoveryHelper | undefined;

export function getAgentDiscoveryHelper(): AgentDiscoveryHelper {
  if (!_discoveryHelper) {
    _discoveryHelper = new BuiltinAgentDiscovery();
  }
  return _discoveryHelper;
}

export function setAgentDiscoveryHelper(
  helper: AgentDiscoveryHelper,
): void {
  _discoveryHelper = helper;
}
