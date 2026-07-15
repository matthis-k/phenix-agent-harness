/**
 * phenix.ts — single Phenix composition entry point
 *
 * The one Pi extension entry for Phenix-owned behavior.
 *
 * Root composition steps:
 * 1. Link configuration.
 * 2. Register generic root integrations.
 * 3. Register routing.
 * 4. Register root workflow composition.
 * 5. Construct runtime services.
 * 6. Construct the selected child-session backend.
 * 7. Construct execution services and the delegator.
 * 8. Register Phenix tools.
 * 9. Register TUI projection and commands.
 * 10. Register shutdown cleanup.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { definePhenixConfiguration } from "./phenix-composition/configuration.ts";
import { link } from "./phenix-composition/linker.ts";
import { DEFAULT_MAXIMUM_DELEGATION_DEPTH } from "./phenix-composition/runtime-policy.ts";
import { defaultContracts } from "./phenix-contracts/index.ts";
import { modelSetRef } from "./phenix-kernel/refs.ts";
import { resolveChildRoute } from "./phenix-routing/child-route.ts";
import {
  defaultAgentRoutes,
  defaultModelPools,
  defaultModelSets,
} from "./phenix-routing/default-routing.ts";
import {
  createChildSessionBackend,
  createSubagentSessionRuntime,
} from "./phenix-runtime/child-session-backend.ts";
import { createSessionSubagentManagerFactory } from "./phenix-runtime/subagent-manager-factory.ts";
import {
  createWorkflowApiTools,
  type WorkflowApiPort,
} from "./phenix-runtime/workflow-api-tools.ts";
import {
  bootstrapPhenixSubagentsSkillPrompt,
  shouldBootstrapPhenixSubagentsSkill,
} from "./phenix-skill-bootstrap.ts";
import { defaultAgentClients } from "./phenix-subagents/definitions.ts";
import { createExecutionQualityService } from "./phenix-subagents/execution-quality-service.ts";
import phenixSubagents from "./phenix-subagents/index.ts";
import {
  createManagedDelegationRuntime,
  type ManagedDelegationRuntime,
} from "./phenix-subagents/managed-delegation-runtime.ts";
import { createWorkflowAcceptanceEngine } from "./phenix-subagents/workflow-acceptance-engine.ts";
import { createWorkflowApi } from "./phenix-subagents/workflow-api.ts";
import { WorkflowDelegator } from "./phenix-subagents/workflow-delegator.ts";

const defaultPhenixConfiguration = definePhenixConfiguration({
  activeModelSet: modelSetRef("mixed"),
  contracts: defaultContracts,
  agentClients: defaultAgentClients,
  routing: {
    modelSets: defaultModelSets,
    pools: defaultModelPools,
    agentRoutes: defaultAgentRoutes,
  },
  runtime: {
    maximumDelegationDepth: DEFAULT_MAXIMUM_DELEGATION_DEPTH,
    persistChildSessions: true,
  },
});

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
      result.status === "loaded" ? `${name}=loaded` : `${name}=failed(${result.error})`,
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
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

function isExecutableAvailable(name: string): boolean {
  const pathValue = process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    try {
      fs.accessSync(path.join(directory, name), fs.constants.X_OK);
      return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

function hasConfiguredWebProvider(): boolean {
  const providerEnvVars = [
    "BRAVE_SEARCH_API_KEY",
    "TAVILY_API_KEY",
    "SERPER_API_KEY",
    "EXA_API_KEY",
    "YOUCOM_API_KEY",
    "JINA_API_KEY",
    "FIRECRAWL_API_KEY",
    "PERPLEXITY_API_KEY",
    "SEARXNG_URL",
    "OLLAMA_HOST",
  ] as const;
  const configuredThroughEnvironment = providerEnvVars.some((name) =>
    Boolean(process.env[name]?.trim()),
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
      "Use the Phenix workflow API for every subagent decision: call `phenix_workflow` to inspect current authority, then `phenix_create_subagent` with one returned transition. Raw `subagent` and legacy `phenix_delegate` calls are runtime-blocked.",
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

function registerTuiProjection(
  pi: ExtensionAPI,
  delegationRuntime: ManagedDelegationRuntime,
): void {
  pi.on("context", async (_event, ctx) => {
    try {
      const activeCount = delegationRuntime.activeCount;
      ctx.ui.setStatus(
        "phenix",
        `Phenix · ${activeCount} active child${activeCount !== 1 ? "ren" : ""}`,
      );
    } catch {
      // UI is optional.
    }
  });
}

function registerShutdown(pi: ExtensionAPI, delegationRuntime: ManagedDelegationRuntime): void {
  pi.on("session_shutdown", async () => {
    await delegationRuntime.shutdown("session shutdown");
  });
}

export default async function phenix(pi: ExtensionAPI): Promise<void> {
  const linkResult = link(defaultPhenixConfiguration);

  if (!linkResult.ok) {
    console.error("[phenix] Link errors detected at startup:");
    for (const diagnostic of linkResult.diagnostics) {
      console.error(
        `  ${diagnostic.severity.toUpperCase()}: [${diagnostic.code}] ${diagnostic.message}`,
      );
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

  await loadIntegration("hypa", pi, async (api) => {
    const mod = await import("@hypabolic/pi-hypa/extensions/index.ts");
    await mod.default(api);
  });
  await loadIntegration("lsp", pi, async (api) => {
    const mod = await import("pi-lsp/extensions/pi-lsp/index.ts");
    await mod.default(api);
  });
  await loadIntegration("mcp", pi, async (api) => {
    const mod = await import("pi-mcp-adapter/index.ts");
    await mod.default(api);
  });
  await loadIntegration("context", pi, async (api) => {
    const mod = await import("pi-context-tools/extensions/index.ts");
    await mod.default(api);
  });
  await loadIntegration("web", pi, async (api) => {
    const mod = await import("@juicesharp/rpiv-web-tools/index.ts");
    await mod.default(api);
  });
  await loadIntegration("phenix-routing", pi, async (api) => {
    const mod = await import("./phenix-routing/index.ts");
    await mod.default(api);
  });

  registerPhenixCodingSubstratePrompt(pi);
  await loadIntegration("phenix-root-workflow", pi, async (api) => {
    const mod = await import("./phenix-composition/root-workflow-integration.ts");
    await mod.default(api);
  });

  let capturedModelRegistry: ModelRegistry | undefined;
  const agentDir = getAgentDir();
  pi.on("session_start", async (_event, ctx) => {
    capturedModelRegistry = ctx.modelRegistry;
  });

  const getRuntimeServices = (): {
    readonly modelRegistry: ModelRegistry;
    readonly agentDir: string;
  } => {
    if (!capturedModelRegistry) {
      throw new Error(
        "Phenix runtime services are not yet available — model registry has not been captured.",
      );
    }
    return { modelRegistry: capturedModelRegistry, agentDir };
  };

  let delegator!: WorkflowDelegator;
  let workflowApi!: WorkflowApiPort;
  const backend = createChildSessionBackend({
    services: {
      get modelRegistry() {
        return getRuntimeServices().modelRegistry;
      },
      agentDir,
    },
    buildCustomTools: (spec) => {
      return createWorkflowApiTools({
        workflow: workflowApi,
        parent: spec.parentContext,
        allowCreate:
          spec.contract.runtime.delegation.remainingDepth > 0 &&
          spec.contract.runtime.delegation.availableRoles.length > 0,
      }) as readonly ToolDefinition[];
    },
  });

  const sessionRuntime = createSubagentSessionRuntime({
    backend,
    resolveRoute: async ({ modelSet, agent, difficulty }) => {
      const route = await resolveChildRoute({ modelSet, role: agent, difficulty });
      return {
        model: { provider: route.model.provider, id: route.model.model },
        thinking: route.thinking,
      };
    },
  });
  const quality = createExecutionQualityService({ sessions: sessionRuntime });
  const acceptance = createWorkflowAcceptanceEngine({ quality });
  const managers = createSessionSubagentManagerFactory({
    sessions: sessionRuntime,
    acceptance,
  });
  const delegationRuntime = createManagedDelegationRuntime({ managers });

  delegator = new WorkflowDelegator({
    delegationRuntime,
    activeModelSet: linkResult.graph.activeModelSet.id,
    maximumDelegationDepth: defaultPhenixConfiguration.runtime.maximumDelegationDepth,
  });
  workflowApi = createWorkflowApi({
    delegator,
    maximumDelegationDepth: defaultPhenixConfiguration.runtime.maximumDelegationDepth,
  });

  await loadIntegration("phenix-subagents", pi, async (api) => {
    await phenixSubagents(api, { delegator, workflow: workflowApi });
  });
  registerTuiProjection(pi, delegationRuntime);
  registerShutdown(pi, delegationRuntime);

  pi.registerCommand("phenix", {
    description: "Inspect the Phenix coding substrate; usage: /phenix doctor",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "doctor";
      if (action !== "doctor") {
        ctx.ui.notify("Usage: /phenix doctor", "warning");
        return;
      }

      const requiredExecutables = [
        "git",
        "gh",
        "rg",
        "fd",
        "jq",
        "ast-grep",
        "rust-analyzer",
        "cargo",
        "cargo-clippy",
        "lua-language-server",
        "typescript-language-server",
        "vscode-json-language-server",
        "nixd",
        "taplo",
        "yaml-language-server",
        "basedpyright-langserver",
        "tend",
        "stitch",
        "stitch-mcp",
      ] as const;
      const missingExecutables = requiredExecutables.filter((name) => !isExecutableAvailable(name));
      const ghAvailable = isExecutableAvailable("gh");
      const failedIntegrations = [...integrationResults.entries()]
        .filter(([, result]) => result.status === "failed")
        .map(([name]) => name);
      const lspConfigPath = path.join(getAgentDir(), "lsp.json");
      const hypaMode = process.env.HYPA_PI_MODE ?? "unknown";
      const lines = [
        `Phenix: linked graph — ${linkResult.ok ? `${linkResult.graph.contracts.size} contracts, ${linkResult.graph.agentClients.size} clients, ${linkResult.graph.routing.modelSets.size} model sets` : "link errors"}`,
        "Backend: sdk",
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
