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
  DefaultResourceLoaderOptions,
} from "@earendil-works/pi-coding-agent";

import type { ChildSessionSpec } from "./child-session-types.ts";
import type { PersonaDefinition } from "./child-session-prompt.ts";

// ── Inline extension registry ───────────────────────────────────────────────

/**
 * A named inline extension factory that can be shared between root and
 * children without recursively loading the whole Phenix extension.
 */
export interface InlineExtension {
  readonly ref: string;
  readonly factory: (pi: unknown) => void | Promise<void>;
}

/**
 * Registry that resolves stable integration references to inline factories.
 *
 * Each integration has one stable reference such as:
 *   hypa, lsp, mcp, context, web
 */
export interface CodingSubstrateIntegrationRegistry {
  resolve(
    refs: readonly string[],
  ): Promise<readonly InlineExtension[]>;
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
  readonly integrationRegistry?: CodingSubstrateIntegrationRegistry;
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

    // Extension factories are resolved by the caller from the integration
    // registry and injected here. The options builder itself does not
    // resolve them to keep this function synchronous and testable.
    extensionFactories: [],

    // Skill paths are resolved by the caller and injected via
    // additionalSkillPaths. The options builder keeps it empty here.
    additionalSkillPaths: [],

    systemPromptOverride: () => systemPrompt,
  };
}
