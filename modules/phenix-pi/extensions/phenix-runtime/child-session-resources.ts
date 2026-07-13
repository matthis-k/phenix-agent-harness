/**
 * child-session-resources — dedicated child resource loader
 *
 * Creates a DefaultResourceLoader configured for a child session.
 * It must NOT rediscover and load the root phenix.ts extension.
 *
 * noExtensions: true is intentional — ambient global/project extensions
 * must not be loaded into every child. Only explicitly resolved inline
 * factories may be present.
 *
 * Generic integrations are extracted from phenix.ts into reusable named
 * inline factories so root and children can share them without recursively
 * loading the whole Phenix extension.
 */

import type {
  DefaultResourceLoader,
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

import type { PersonaDefinition } from "./child-session-prompt.ts";
import type { ChildSessionSpec } from "./child-session-types.ts";

// ── Inline extension registry ───────────────────────────────────────────────

/**
 * A named inline extension factory that can be shared between root and
 * children without recursively loading the whole Phenix extension.
 */
export interface InlineExtension {
  readonly ref: string;
  readonly factory: ExtensionFactory;
}

/**
 * Registry that resolves stable integration references to inline factories.
 *
 * Each integration has one stable reference such as:
 *   hypa, lsp, mcp, context, web
 */
export interface CodingSubstrateIntegrationRegistry {
  resolve(refs: readonly string[]): Promise<readonly InlineExtension[]>;
}

// ── Persona loading ─────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentKind } from "../phenix-kernel/agents.ts";

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
 * Load a persona definition for a role.
 *
 * Returns plain content — no YAML/frontmatter files are generated.
 * Persona files provide prose only. They must not become a second
 * authority for tools, thinking, routing, or delegation.
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

  const personasDir = resolvePersonasDir();
  const filePath = path.join(personasDir, `${role}.md`);

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return {
      role,
      body: stripFrontmatter(content),
    };
  } catch {
    return {
      role,
      body: `You are a Phenix ${role} agent. Complete the assigned task and call phenix_complete when finished.`,
    };
  }
}

// ── Child resource loader options ───────────────────────────────────────────

/**
 * Build DefaultResourceLoaderOptions for a child session.
 *
 * The child loader does not load phenix.ts, does not discover ambient
 * project extensions, and only loads explicitly referenced inline factories.
 */
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

    // noExtensions: true — ambient global/project extensions must not be
    // loaded into every child. Only explicitly resolved inline factories.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !spec.inheritProjectContext,

    // Only explicitly resolved inline factories are loaded.
    extensionFactories: [...(input.extensionFactories ?? [])],

    // Skill references are resolved to concrete paths by the caller.
    additionalSkillPaths: [...(input.skillPaths ?? [])],

    systemPromptOverride: () => systemPrompt,
  };
}

/**
 * Infer the minimal integration set from the exact tool allowlist.
 *
 * Agent definitions currently carry tools as the authoritative capability
 * surface. This keeps extension loading derived from that surface instead
 * of reintroducing a second ambient configuration source.
 */
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
 * Resolve named integrations to inline extension factories.
 *
 * Loading remains explicit and child-local; the root Phenix extension is
 * never rediscovered by DefaultResourceLoader.
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
          await mod.default(pi, {
            interceptors: { github: true },
          });
        };
      default:
        throw new Error(`Unknown child extension reference: ${ref}`);
    }
  });
}

/**
 * Resolve skill references without enabling ambient skill discovery.
 */
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
