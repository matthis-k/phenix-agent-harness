/**
 * child-session-resources — dedicated child resource loader
 *
 * Creates a DefaultResourceLoader configured for a child session.
 * It must NOT rediscover and load the root phenix.ts extension.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  DefaultResourceLoader,
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import type { AgentKind } from "@matthis-k/phenix-kernel/agents.ts";
import type { PersonaDefinition } from "./child-session-prompt.ts";
import type { ChildSessionSpec } from "./child-session-types.ts";

export type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Explicit child-local extension factory. */
export interface InlineExtension {
  readonly ref: string;
  readonly factory: ExtensionFactory;
}

/** Resolves stable integration references to child-local extension factories. */
export interface CodingSubstrateIntegrationRegistry {
  resolve(refs: readonly string[]): Promise<readonly InlineExtension[]>;
}

function resolvePersonasDir(): string {
  return fileURLToPath(new URL("../../agents", import.meta.url));
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown.trim();
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return markdown.trim();
  return markdown.slice(end + "\n---\n".length).trim();
}

/**
 * Load persona prose for a role.
 *
 * Persona files are descriptive only; they do not own tools, routing, thinking,
 * or delegation policy.
 */
export function loadPersona(role: AgentKind | null): PersonaDefinition {
  if (role === null) {
    return {
      role: null,
      body:
        "You are a minimal, bounded Phenix child agent. " +
        "Complete the assigned task using your authorized tools and call phenix_complete when finished.",
    };
  }

  const filePath = path.join(resolvePersonasDir(), `${role}.md`);
  try {
    return {
      role,
      body: stripFrontmatter(fs.readFileSync(filePath, "utf-8")),
    };
  } catch {
    return {
      role,
      body: `You are a Phenix ${role} agent. Complete the assigned task and call phenix_complete when finished.`,
    };
  }
}

/** Build an isolated resource-loader configuration for one child session. */
export function buildChildResourceLoaderOptions(input: {
  readonly spec: ChildSessionSpec;
  readonly agentDir: string;
  readonly systemPrompt: string;
  readonly extensionFactories?: readonly ExtensionFactory[];
  readonly skillPaths?: readonly string[];
}): DefaultResourceLoaderOptions {
  const { spec, agentDir, systemPrompt } = input;

  return {
    cwd: spec.cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !spec.inheritProjectContext,
    extensionFactories: [...(input.extensionFactories ?? [])],
    additionalSkillPaths: [...(input.skillPaths ?? [])],
    systemPromptOverride: () => systemPrompt,
  };
}

/** Infer the minimal integration set from the exact child tool allowlist. */
export function inferChildIntegrationRefs(
  tools: readonly string[],
  explicit: readonly string[],
): readonly string[] {
  const refs = new Set(explicit);
  const has = (prefix: string): boolean =>
    tools.some((tool) => tool === prefix || tool.startsWith(`${prefix}_`));

  if (
    tools.some((tool) =>
      [
        "read",
        "grep",
        "search",
        "find",
        "ls",
        "tree",
        "edit",
        "write",
        "apply_patch",
        "ast_grep",
        "ast_edit",
        "todo",
      ].includes(tool),
    )
  ) {
    refs.add("hypa");
  }
  if (has("lsp")) refs.add("lsp");
  if (has("mcp")) refs.add("mcp");
  if (has("context")) refs.add("context");
  if (has("web") || tools.includes("fetch_content") || tools.includes("get_search_content")) {
    refs.add("web");
  }

  return [...refs].sort();
}

/**
 * Resolve named integrations to child-local factories.
 *
 * The web-tools package currently exposes a one-argument extension factory;
 * interception policy is owned by that package rather than configured here.
 */
export async function resolveChildExtensionFactories(
  refs: readonly string[],
): Promise<readonly ExtensionFactory[]> {
  return refs.map((ref) => {
    switch (ref) {
      case "hypa":
        return async (pi: ExtensionAPI) => {
          const mod = await import("@hypabolic/pi-hypa/extensions/index.ts");
          await mod.default(pi);
        };
      case "lsp":
        return async (pi: ExtensionAPI) => {
          const mod = await import("pi-lsp/extensions/pi-lsp/index.ts");
          await mod.default(pi);
        };
      case "mcp":
        return async (pi: ExtensionAPI) => {
          const mod = await import("pi-mcp-adapter/index.ts");
          await mod.default(pi);
        };
      case "context":
        return async (pi: ExtensionAPI) => {
          const mod = await import("pi-context-tools/extensions/index.ts");
          await mod.default(pi);
        };
      case "web":
        return async (pi: ExtensionAPI) => {
          const mod = await import("@juicesharp/rpiv-web-tools/index.ts");
          await mod.default(pi);
        };
      default:
        throw new Error(`Unknown child extension reference: ${ref}`);
    }
  });
}

/** Resolve explicit child skill references to concrete paths. */
export function resolveChildSkillPaths(
  refs: readonly string[],
  agentDir: string,
): readonly string[] {
  const resolved: string[] = [];

  for (const ref of refs) {
    const candidates = path.isAbsolute(ref)
      ? [ref]
      : [
          path.join(agentDir, "skills", ref),
          path.join(agentDir, "skills", ref, "SKILL.md"),
          path.resolve(ref),
        ];

    const match = candidates.find((candidate) => fs.existsSync(candidate));
    if (!match) {
      throw new Error(`Unknown child skill reference: ${ref}`);
    }
    resolved.push(match);
  }

  return [...new Set(resolved)].sort();
}
