/**
 * phenix.ts — single Phenix composition entry point
 *
 * This is the one Pi extension entry for Phenix-owned behavior.
 * It replaces phenix-contract-runtime.ts, phenix-routing/index.ts,
 * and phenix-core.ts as separate extension entry points.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  decodeContractBootstrapEnvironment,
} from "./phenix-subagents/contract-identity.ts";

import { modelSetRef } from "./phenix-kernel/refs.ts";
import { PHENIX_PROVIDER } from "./phenix-routing/provider.ts";
import { defaultContracts } from "./phenix-contracts/index.ts";
import {
  defaultAgentClients,
} from "./phenix-subagents/definitions.ts";
import {
  defaultModelPools,
  defaultModelSets,
  defaultAgentRoutes,
} from "./phenix-routing/default-routing.ts";
import {
  definePhenixConfiguration,
} from "./phenix-composition/configuration.ts";
import type { PhenixConfiguration } from "./phenix-composition/configuration.ts";
import { link } from "./phenix-composition/linker.ts";

// ── Default configuration ──────────────────────────────────────────────────

const defaultPhenixConfiguration = definePhenixConfiguration({
  activeModelSet: modelSetRef("mixed"),
  contracts: defaultContracts,
  agentClients: defaultAgentClients,
  routing: {
    modelSets: defaultModelSets,
    pools: defaultModelPools,
    agentRoutes: defaultAgentRoutes,
  },
  workflows: [
    // Loaded lazily from the existing workflow definition
  ],
  runtime: {
    subagentBackend: "pi-subagents-process",
    maximumDelegationDepth: 3,
  },
});

// ── Integration helpers ──────────────────────────────────────────────────

type IntegrationResult =
  | { readonly status: "loaded" }
  | { readonly status: "failed"; readonly error: string };

const integrationResults = new Map<string, IntegrationResult>();

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function loadIntegration(
  name: string,
  pi: ExtensionAPI,
  loader: (pi: ExtensionAPI) => Promise<void>,
): Promise<void> {
  try {
    await loader(pi);
    integrationResults.set(name, { status: "loaded" });
  } catch (error) {
    integrationResults.set(name, {
      status: "failed",
      error: formatError(error),
    });
  }
}

function integrationSummary(): string {
  return [...integrationResults.entries()]
    .map(([name, result]) =>
      result.status === "loaded"
        ? `${name}=loaded`
        : `${name}=failed(${result.error})`,
    )
    .join(", ");
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function getConfigHome(): string {
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
}

function exists(candidate: string): boolean {
  try { return fs.existsSync(candidate); } catch { return false; }
}

function isExecutableAvailable(name: string): boolean {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    try {
      fs.accessSync(path.join(directory, name), fs.constants.X_OK);
      return true;
    } catch { /* continue */ }
  }
  return false;
}

function hasConfiguredWebProvider(): boolean {
  const providerEnvVars = [
    "BRAVE_SEARCH_API_KEY", "TAVILY_API_KEY", "SERPER_API_KEY",
    "EXA_API_KEY", "YOUCOM_API_KEY", "JINA_API_KEY",
    "FIRECRAWL_API_KEY", "PERPLEXITY_API_KEY", "SEARXNG_URL",
    "OLLAMA_HOST",
  ] as const;
  const configuredThroughEnvironment = providerEnvVars.some(
    (name) => Boolean(process.env[name]?.trim()),
  );
  const configFile = path.join(getConfigHome(), "rpiv-web-tools", "config.json");
  return configuredThroughEnvironment || exists(configFile);
}

function hasConfiguredMcpServer(cwd: string): boolean {
  const agentDir = getAgentDir();
  const candidates = [
    path.join(getConfigHome(), "mcp", "mcp.json"),
    path.join(agentDir, "mcp.json"),
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".pi", "mcp.json"),
  ];
  return candidates.some(exists);
}

function registerBundledSubagentAgents(): void {
  const bundled = fileURLToPath(new URL("../agents", import.meta.url));
  const current = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS
    ?.split(path.delimiter)
    .filter(Boolean) ?? [];
  process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = [
    bundled,
    ...current.filter((entry) => path.resolve(entry) !== path.resolve(bundled)),
  ].join(path.delimiter);
}

const PHENIX_SUBAGENTS_SKILL_NAME = "phenix-subagents";

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown.trim();
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return markdown.trim();
  return markdown.slice(end + "\n---\n".length).trim();
}

function phenixSubagentsSkillBlock(): string {
  const skillDirectory = fileURLToPath(
    new URL("../skills/phenix-subagents", import.meta.url),
  );
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const skillBody = stripFrontmatter(fs.readFileSync(skillPath, "utf8"));

  return [
    `<skill name="${PHENIX_SUBAGENTS_SKILL_NAME}" location="${skillPath}">`,
    `References are relative to ${skillDirectory}.`,
    "",
    skillBody,
    "</skill>",
  ].join("\n");
}

export function shouldBootstrapPhenixSubagentsSkill(
  model: { readonly provider?: string } | null | undefined,
): boolean {
  return model?.provider === PHENIX_PROVIDER;
}

export function bootstrapPhenixSubagentsSkillPrompt(systemPrompt: string): string {
  if (systemPrompt.includes(`<skill name="${PHENIX_SUBAGENTS_SKILL_NAME}"`)) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n${phenixSubagentsSkillBlock()}`;
}

function registerPhenixCodingSubstratePrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const systemPrompt = shouldBootstrapPhenixSubagentsSkill(ctx.model)
      ? bootstrapPhenixSubagentsSkillPrompt(event.systemPrompt)
      : event.systemPrompt;

    const guidance = [
      "Use focused searches and bounded reads instead of dumping entire repositories or logs.",
      "Prefer LSP tools for diagnostics, types, symbols, definitions, and references when a matching server exists.",
      "Run LSP diagnostics on changed supported files before reporting completion.",
      "Use the `mcp` proxy to discover MCP capabilities on demand instead of assuming every MCP tool is directly registered.",
      "Use `web_search` for external discovery and `web_fetch` for specific pages; use `gh` through the shell for GitHub-native operations.",
      "Use `context_info` and compact only at coherent boundaries during genuinely long tasks.",
      "Use `phenix_delegate` for real isolated subagents. Raw `subagent` calls are runtime-blocked so model selection, thinking, permissions, persistence, contracts, and verification cannot be bypassed.",
      "Every delegated handoff must use a strict output schema. Invalid structured output is returned to the child with exact validation failures so it can repair the handoff.",
      "Runtime verification and critic gates are authoritative. Do not treat a model's claim that tests passed as verification evidence.",
      "The shell is intentionally permissive, but avoid destructive or unrelated operations unless the task requires them.",
    ].join("\n- ");

    return {
      systemPrompt: `${systemPrompt}

## Phenix coding substrate

- ${guidance}`,
    };
  });
}

// ── Default export — Phenix composition entry point ────────────────────────

export default async function phenix(
  pi: ExtensionAPI,
): Promise<void> {
  // ── Detect root vs child process ─────────────────────────────
  const envState = decodeContractBootstrapEnvironment();

  if (envState.kind === "child") {
    // Child process — only load contract runtime and routing.
    await loadIntegration("phenix-contract-runtime", pi, async (api) => {
      const mod = await import("./phenix-contract-runtime.ts");
      await mod.default(api);
    });
    await loadIntegration("phenix-routing", pi, async (api) => {
      const mod = await import("./phenix-routing/index.ts");
      await mod.default(api);
    });
    return;
  }

  // ── Root process below ──────────────────────────────────────
  // ── 1. Perform startup linking and validation ─────────────────
  // Merge user configuration with this default.
  // For now, use the default configuration directly.
  const linkResult = link(defaultPhenixConfiguration);

  if (!linkResult.ok) {
    console.error("[phenix] Link errors detected at startup:");
    for (const diag of linkResult.diagnostics) {
      console.error(`  ${diag.severity.toUpperCase()}: [${diag.code}] ${diag.message}`);
    }
    throw new Error(
      `Phenix startup aborted: ${linkResult.diagnostics.length} link error(s) found.`,
    );
  }

  console.error(
    `[phenix] Linked graph: ` +
    `${linkResult.graph.contracts.size} contracts, ` +
    `${linkResult.graph.agentClients.size} agent clients, ` +
    `${linkResult.graph.routing.modelSets.size} model sets, ` +
    `${linkResult.graph.routing.agentRoutes.size} agent routes.`,
  );

  // ── 2. Register bundled subagent agent directories ────────────
  registerBundledSubagentAgents();

  // ── 3. Generic integrations ──────────────────────────────────

  // Hypa — local tool replacement layer
  await loadIntegration("hypa", pi, async (api) => {
    const mod = await import("@hypabolic/pi-hypa/extensions/index.ts");
    await mod.default(api);
  });

  // LSP — language server support
  await loadIntegration("lsp", pi, async (api) => {
    const mod = await import("pi-lsp/extensions/pi-lsp/index.ts");
    await mod.default(api);
  });

  // MCP adapter — single proxy tool
  await loadIntegration("mcp", pi, async (api) => {
    const mod = await import("pi-mcp-adapter/index.ts");
    await mod.default(api);
  });

  // Context tools — explicit inspection and compaction
  await loadIntegration("context", pi, async (api) => {
    const mod = await import("pi-context-tools/extensions/index.ts");
    await mod.default(api);
  });

  // Web tools — web search and fetch
  await loadIntegration("web", pi, async (api) => {
    const mod = await import("@juicesharp/rpiv-web-tools/index.ts");
    await mod.default(api, { interceptors: { github: true } });
  });

  // Process-isolated subagents and lifecycle/status support
  await loadIntegration("subagents", pi, async (api) => {
    const mod = await import("pi-subagents/src/extension/index.ts");
    await mod.default(api);
  });

  // ── 4. Phenix-specific extensions ────────────────────────────

  // Phenix routing — virtual provider and route state
  await loadIntegration("phenix-routing", pi, async (api) => {
    const mod = await import("./phenix-routing/index.ts");
    await mod.default(api);
  });

  // Phenix coding substrate prompt injection. Register before workflow
  // projection so the workflow authority remains the final prompt layer.
  registerPhenixCodingSubstratePrompt(pi);

  // Phenix root workflow composition — deterministic root workflow authority
  await loadIntegration("phenix-root-workflow", pi, async (api) => {
    const mod = await import("./phenix-composition/root-workflow-integration.ts");
    await mod.default(api);
  });

  // Phenix contract runtime — child bootstrap, phenix_complete, tool guards
  await loadIntegration("phenix-contract-runtime", pi, async (api) => {
    const mod = await import("./phenix-contract-runtime.ts");
    await mod.default(api);
  });

  // Phenix policy and typed handoff layer over pi-subagents
  await loadIntegration("phenix-subagents", pi, async (api) => {
    const mod = await import("./phenix-subagents/index.ts");
    await mod.default(api);
  });

  // ── 5. /phenix doctor command ─────────────────────────────────

  pi.registerCommand("phenix", {
    description: "Inspect the Phenix coding substrate; usage: /phenix doctor",

    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "doctor";

      if (action !== "doctor") {
        ctx.ui.notify("Usage: /phenix doctor", "warning");
        return;
      }

      const requiredExecutables = [
        "git", "gh", "rg", "fd", "jq", "ast-grep",
        "rust-analyzer", "cargo", "cargo-clippy",
        "lua-language-server", "typescript-language-server",
        "vscode-json-language-server", "nixd", "taplo",
        "yaml-language-server", "basedpyright-langserver",
      ] as const;

      const missingExecutables = requiredExecutables.filter(
        (name) => !isExecutableAvailable(name),
      );

      const ghAvailable = isExecutableAvailable("gh");
      const failedIntegrations = [...integrationResults.entries()]
        .filter(([, result]) => result.status === "failed")
        .map(([name]) => name);

      const lspConfigPath = path.join(getAgentDir(), "lsp.json");
      const hypaMode = process.env.HYPA_PI_MODE ?? "unknown";

      const lines = [
        `Phenix: linked graph — ${linkResult.ok ? `${linkResult.graph.contracts.size} contracts, ${linkResult.graph.agentClients.size} clients, ${linkResult.graph.routing.modelSets.size} model sets` : "link errors"}`,
        `Integrations: ${integrationSummary()}`,
        `LSP config: ${exists(lspConfigPath) ? lspConfigPath : `missing (${lspConfigPath})`}`,
        `Hypa mode: ${hypaMode}`,
        `MCP servers: ${hasConfiguredMcpServer(ctx.cwd) ? "configuration detected" : "none configured; use /mcp setup or add .mcp.json"}`,
        `Web provider: ${hasConfiguredWebProvider() ? "configuration detected" : "not configured; run /web-tools"}`,
        `Executables: ${missingExecutables.length === 0 ? `${requiredExecutables.length}/${requiredExecutables.length} available` : `missing ${missingExecutables.join(", ")}`}`,
        `GitHub CLI: ${ghAvailable ? "installed" : "not found"}`,
      ];

      const level =
        failedIntegrations.length > 0 || missingExecutables.length > 0 || !exists(lspConfigPath)
          ? "warning"
          : "info";

      ctx.ui.notify(lines.join("\n"), level);
    },
  });
}
