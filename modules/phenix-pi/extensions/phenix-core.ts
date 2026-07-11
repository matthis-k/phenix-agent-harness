import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerHypa from "@hypabolic/pi-hypa/extensions/index.ts";
import registerWebTools from "@juicesharp/rpiv-web-tools/index.ts";
import registerContextTools from "pi-context-tools/extensions/index.ts";
import registerLsp from "pi-lsp/extensions/pi-lsp/index.ts";
import registerMcp from "pi-mcp-adapter/index.ts";

type IntegrationFactory = (
  pi: ExtensionAPI,
) => void | Promise<void>;

type IntegrationResult =
  | { readonly status: "loaded" }
  | { readonly status: "failed"; readonly error: string };

const integrationResults = new Map<string, IntegrationResult>();

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function loadIntegration(
  name: string,
  pi: ExtensionAPI,
  factory: IntegrationFactory,
): Promise<void> {
  try {
    await factory(pi);
    integrationResults.set(name, { status: "loaded" });
  } catch (error) {
    integrationResults.set(name, {
      status: "failed",
      error: formatError(error),
    });
  }
}

function getAgentDir(): string {
  return (
    process.env.PI_AGENT_DIR ??
    process.env.PI_CODING_AGENT_DIR ??
    path.join(os.homedir(), ".pi", "agent")
  );
}

function getConfigHome(): string {
  return (
    process.env.XDG_CONFIG_HOME ??
    path.join(os.homedir(), ".config")
  );
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
    if (!directory) {
      continue;
    }

    const candidate = path.join(directory, name);

    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }

  return false;
}

function hasConfiguredWebProvider(): boolean {
  const providerEnvironmentVariables = [
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

  const configuredThroughEnvironment =
    providerEnvironmentVariables.some(
      (name) => Boolean(process.env[name]?.trim()),
    );

  const configFile = path.join(
    getConfigHome(),
    "rpiv-web-tools",
    "config.json",
  );

  return configuredThroughEnvironment || exists(configFile);
}

function hasConfiguredMcpServer(cwd: string): boolean {
  const agentDir = getAgentDir();
  const configHome = getConfigHome();

  const candidates = [
    path.join(configHome, "mcp", "mcp.json"),
    path.join(agentDir, "mcp.json"),
    path.join(cwd, ".mcp.json"),
    path.join(cwd, ".pi", "mcp.json"),
  ];

  return candidates.some(exists);
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

export default async function phenixCore(
  pi: ExtensionAPI,
): Promise<void> {
  await loadIntegration(
    "lsp",
    pi,
    registerLsp,
  );

  await loadIntegration(
    "mcp",
    pi,
    registerMcp,
  );

  await loadIntegration(
    "context",
    pi,
    registerContextTools,
  );

  await loadIntegration(
    "hypa",
    pi,
    registerHypa,
  );

  await loadIntegration(
    "web",
    pi,
    (api) =>
      registerWebTools(api, {
        interceptors: {
          github: true,
        },
      }),
  );

  pi.on("before_agent_start", async (event) => {
    const guidance = [
      "Use focused searches and bounded reads instead of dumping entire repositories or logs.",
      "Prefer LSP tools for diagnostics, types, symbols, definitions, and references when a matching server exists.",
      "Run LSP diagnostics on changed supported files before reporting completion.",
      "Use the `mcp` proxy to discover MCP capabilities on demand instead of assuming every MCP tool is directly registered.",
      "Use `web_search` for external discovery and `web_fetch` for specific pages; use `gh` through the shell for GitHub-native operations.",
      "Use `context_info` and compact only at coherent boundaries during genuinely long tasks.",
      "The shell is intentionally permissive, but avoid destructive or unrelated operations unless the task requires them.",
    ].join("\n- ");

    return {
      systemPrompt: `${event.systemPrompt}

## Phenix coding substrate

- ${guidance}`,
    };
  });

  pi.registerCommand("phenix", {
    description: "Inspect the Phenix coding substrate; usage: /phenix doctor",

    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase() || "doctor";

      if (action !== "doctor") {
        ctx.ui.notify(
          "Usage: /phenix doctor",
          "warning",
        );
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
      ] as const;

      const missingExecutables = requiredExecutables.filter(
        (name) => !isExecutableAvailable(name),
      );

      const failedIntegrations = [...integrationResults.entries()]
        .filter(([, result]) => result.status === "failed")
        .map(([name]) => name);

      const lspConfigPath = path.join(
        getAgentDir(),
        "lsp.json",
      );

      const lines = [
        `Integrations: ${integrationSummary()}`,
        `LSP config: ${
          exists(lspConfigPath)
            ? lspConfigPath
            : `missing (${lspConfigPath})`
        }`,
        `MCP servers: ${
          hasConfiguredMcpServer(ctx.cwd)
            ? "configuration detected"
            : "none configured; use /mcp setup or add .mcp.json"
        }`,
        `Web provider: ${
          hasConfiguredWebProvider()
            ? "configuration detected"
            : "not configured; run /web-tools"
        }`,
        `Executables: ${
          missingExecutables.length === 0
            ? `${requiredExecutables.length}/${requiredExecutables.length} available`
            : `missing ${missingExecutables.join(", ")}`
        }`,
      ];

      const level =
        failedIntegrations.length > 0 ||
        missingExecutables.length > 0 ||
        !exists(lspConfigPath)
          ? "warning"
          : "info";

      ctx.ui.notify(
        lines.join("\n"),
        level,
      );
    },
  });
}
