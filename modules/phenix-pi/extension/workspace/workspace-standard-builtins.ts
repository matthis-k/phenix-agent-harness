import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  getPackageDir,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  confirmWorkspaceAction,
  inputWorkspaceValue,
  pickWorkspaceItem,
  pickWorkspaceItems,
  runWorkspaceActivity,
  showWorkspaceDocument,
  type WorkspaceActivityController,
} from "./workspace-dialogs.ts";
import type { WorkspaceSelectDialogItem } from "./workspace-select-dialog.ts";

export const STANDARD_BUILTIN_COMMANDS = [
  ["settings", "Configure Pi and Phenix workspace behavior"],
  ["model", "Select the active model"],
  ["scoped-models", "Choose models used by model cycling"],
  ["export", "Export the current session"],
  ["import", "Import a session JSONL file"],
  ["share", "Publish the current session as a secret gist"],
  ["copy", "Copy the last assistant message"],
  ["name", "Set the session display name"],
  ["session", "Show current session information"],
  ["changelog", "Show the Pi changelog"],
  ["hotkeys", "Show keyboard shortcuts"],
  ["fork", "Fork from an earlier user message"],
  ["clone", "Clone the current session state"],
  ["tree", "Navigate the session tree"],
  ["trust", "Change project trust"],
  ["login", "Configure provider authentication"],
  ["logout", "Remove stored provider credentials"],
  ["new", "Start a new session"],
  ["compact", "Compact the current session context"],
  ["resume", "Resume another session"],
  ["reload", "Reload Pi resources"],
  ["quit", "Exit Pi"],
] as const;

export type StandardBuiltinCommand = (typeof STANDARD_BUILTIN_COMMANDS)[number][0];

const STANDARD_BUILTIN_NAMES = new Set<string>(STANDARD_BUILTIN_COMMANDS.map(([name]) => name));
const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function registerWorkspaceStandardBuiltins(pi: ExtensionAPI): void {
  for (const [name, description] of STANDARD_BUILTIN_COMMANDS) {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        try {
          const suffix = args.trim();
          await runWorkspaceBuiltin(pi, ctx, `/${name}${suffix ? ` ${suffix}` : ""}`);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
  }
}

export function isStandardBuiltinCommand(text: string): boolean {
  const parsed = parseWorkspaceCommand(text);
  return parsed !== undefined && STANDARD_BUILTIN_NAMES.has(parsed.name);
}

export function standardBuiltinCommandInfo(): readonly { name: string; description: string }[] {
  return STANDARD_BUILTIN_COMMANDS.map(([name, description]) => ({ name, description }));
}

export function parseWorkspaceCommand(text: string): { name: string; args: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const separator = trimmed.search(/\s/u);
  if (separator < 0) return { name: trimmed.slice(1), args: "" };
  return {
    name: trimmed.slice(1, separator),
    args: trimmed.slice(separator).trim(),
  };
}

export async function runWorkspaceBuiltin(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  commandText: string,
): Promise<void> {
  const parsed = parseWorkspaceCommand(commandText);
  if (!parsed || !STANDARD_BUILTIN_NAMES.has(parsed.name)) {
    throw new Error(`Unknown standard command: ${commandText}`);
  }

  switch (parsed.name as StandardBuiltinCommand) {
    case "settings":
      await openSettings(pi, ctx);
      return;
    case "model":
      await openModelPicker(pi, ctx, parsed.args);
      return;
    case "scoped-models":
      await openScopedModels(ctx);
      return;
    case "export":
      await exportSession(pi, ctx, parsed.args);
      return;
    case "import":
      await importSession(ctx, parsed.args);
      return;
    case "share":
      await shareSession(pi, ctx);
      return;
    case "copy":
      await copyLastAssistantMessage(ctx);
      return;
    case "name":
      await setSessionName(pi, ctx, parsed.args);
      return;
    case "session":
      await showSessionInfo(ctx);
      return;
    case "changelog":
      await showChangelog(ctx);
      return;
    case "hotkeys":
      await showHotkeys(ctx);
      return;
    case "fork":
      await forkSession(ctx);
      return;
    case "clone":
      await cloneSession(ctx);
      return;
    case "tree":
      await navigateSessionTree(ctx);
      return;
    case "trust":
      await configureTrust(ctx);
      return;
    case "login":
      await loginProvider(ctx, parsed.args);
      return;
    case "logout":
      await logoutProvider(ctx, parsed.args);
      return;
    case "new":
      await newSession(ctx);
      return;
    case "compact":
      await compactSession(ctx, parsed.args);
      return;
    case "resume":
      await resumeSession(ctx);
      return;
    case "reload":
      await reloadResources(ctx);
      return;
    case "quit":
      await quitPi(ctx);
      return;
  }
}

async function openModelPicker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  requestedModel = "",
): Promise<void> {
  const models = [...(await ctx.modelRegistry.getAvailable())].sort((left, right) =>
    `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
  );
  const requested = requestedModel.trim().toLowerCase();
  const direct = requested
    ? models.find((model) => {
        const id = `${model.provider}/${model.id}`.toLowerCase();
        return id === requested || model.id.toLowerCase() === requested;
      })
    : undefined;
  const current = ctx.model;
  const selection =
    direct ??
    (await pickWorkspaceItem(ctx, {
      title: "Select model",
      items: models.map((model) => ({
        id: `${model.provider}/${model.id}`,
        label: model.name || model.id,
        detail: `${model.provider}${model.reasoning ? " · reasoning" : ""}`,
        searchText: `${model.provider} ${model.id} ${model.name ?? ""}`,
        current: current?.provider === model.provider && current.id === model.id,
        value: model,
      })),
      emptyMessage: "No available models",
    }));
  if (!selection) return;
  const result = await pi.setModel(selection);
  if (!result) throw new Error(`Could not select ${selection.provider}/${selection.id}`);
  ctx.ui.notify(`Model: ${selection.provider}/${selection.id}`, "info");
}

async function openSettings(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const settings = createSettings(ctx);
  while (true) {
    const choice = await pickWorkspaceItem(ctx, {
      title: "Settings",
      items: [
        {
          id: "model",
          label: "Model",
          detail: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none",
          value: "model",
        },
        {
          id: "thinking",
          label: "Thinking level",
          detail: pi.getThinkingLevel(),
          value: "thinking",
        },
        {
          id: "theme",
          label: "Theme",
          detail: ctx.ui.theme.name ?? "custom",
          value: "theme",
        },
        {
          id: "tools",
          label: "Active tools",
          detail: `${pi.getActiveTools().length}/${pi.getAllTools().length}`,
          value: "tools",
        },
        {
          id: "tool-output",
          label: "Tool output",
          detail: ctx.ui.getToolsExpanded() ? "expanded" : "collapsed",
          value: "tool-output",
        },
        {
          id: "scoped-models",
          label: "Model cycle scope",
          detail: `${settings.getEnabledModels()?.length ?? "all"}`,
          value: "scoped-models",
        },
        {
          id: "hide-thinking",
          label: "Thinking blocks",
          detail: settings.getHideThinkingBlock() ? "hidden" : "visible",
          value: "hide-thinking",
        },
        {
          id: "retry",
          label: "Automatic retry",
          detail: settings.getRetryEnabled() ? "enabled" : "disabled",
          value: "retry",
        },
        {
          id: "images",
          label: "Inline images",
          detail: settings.getShowImages() ? "enabled" : "disabled",
          value: "images",
        },
        {
          id: "double-escape",
          label: "Double Escape",
          detail: settings.getDoubleEscapeAction(),
          value: "double-escape",
        },
        {
          id: "default-trust",
          label: "Default project trust",
          detail: settings.getDefaultProjectTrust(),
          value: "default-trust",
        },
      ],
    });
    if (!choice) return;

    if (choice === "model") await openModelPicker(pi, ctx);
    else if (choice === "thinking") await selectThinkingLevel(pi, ctx, settings);
    else if (choice === "theme") await selectTheme(ctx, settings);
    else if (choice === "tools") await selectTools(pi, ctx);
    else if (choice === "tool-output") ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
    else if (choice === "scoped-models") await openScopedModels(ctx);
    else if (choice === "hide-thinking") {
      settings.setHideThinkingBlock(!settings.getHideThinkingBlock());
      await settings.flush();
    } else if (choice === "retry") {
      settings.setRetryEnabled(!settings.getRetryEnabled());
      await settings.flush();
    } else if (choice === "images") {
      settings.setShowImages(!settings.getShowImages());
      await settings.flush();
    } else if (choice === "double-escape") {
      const action = await pickWorkspaceItem(ctx, {
        title: "Double Escape action",
        items: ["tree", "fork", "none"].map((value) => ({
          id: value,
          label: value,
          current: settings.getDoubleEscapeAction() === value,
          value,
        })),
      });
      if (action) {
        settings.setDoubleEscapeAction(action as "tree" | "fork" | "none");
        await settings.flush();
      }
    } else if (choice === "default-trust") {
      const trust = await pickWorkspaceItem(ctx, {
        title: "Default project trust",
        items: ["ask", "always", "never"].map((value) => ({
          id: value,
          label: value,
          current: settings.getDefaultProjectTrust() === value,
          value,
        })),
      });
      if (trust) {
        settings.setDefaultProjectTrust(trust as "ask" | "always" | "never");
        await settings.flush();
      }
    }
  }
}

async function selectThinkingLevel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: SettingsManager,
): Promise<void> {
  const current = pi.getThinkingLevel();
  const level = await pickWorkspaceItem(ctx, {
    title: "Thinking level",
    items: THINKING_LEVELS.map((value) => ({
      id: value,
      label: value,
      current: current === value,
      value,
    })),
  });
  if (!level) return;
  pi.setThinkingLevel(level);
  settings.setDefaultThinkingLevel(level);
  await settings.flush();
}

async function selectTheme(ctx: ExtensionContext, settings: SettingsManager): Promise<void> {
  const themes = ctx.ui.getAllThemes();
  const current = ctx.ui.theme.name;
  const theme = await pickWorkspaceItem(ctx, {
    title: "Theme",
    items: themes.map(({ name, path }) => ({
      id: name,
      label: name,
      detail: path,
      current: name === current,
      value: name,
    })),
  });
  if (!theme) return;
  const result = ctx.ui.setTheme(theme);
  if (!result.success) throw new Error(result.error ?? `Could not set theme ${theme}`);
  settings.setTheme(theme);
  await settings.flush();
}

async function selectTools(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const active = new Set(pi.getActiveTools());
  const selected = await pickWorkspaceItems(ctx, {
    title: "Active tools",
    items: pi.getAllTools().map((tool) => ({
      id: tool.name,
      label: tool.name,
      detail: tool.description,
      checked: active.has(tool.name),
      value: tool.name,
    })),
  });
  if (selected) pi.setActiveTools([...selected]);
}

async function openScopedModels(ctx: ExtensionCommandContext): Promise<void> {
  const settings = createSettings(ctx);
  const enabled = settings.getEnabledModels();
  const enabledSet = enabled ? new Set(enabled) : undefined;
  const models = [...ctx.modelRegistry.getAll()].sort((left, right) =>
    `${left.provider}/${left.id}`.localeCompare(`${right.provider}/${right.id}`),
  );
  const selected = await pickWorkspaceItems(ctx, {
    title: "Models used by cycling",
    items: models.map((model) => {
      const id = `${model.provider}/${model.id}`;
      return {
        id,
        label: model.name || model.id,
        detail: model.provider,
        checked: enabledSet ? enabledSet.has(id) : true,
        value: id,
      };
    }),
  });
  if (!selected) return;
  settings.setEnabledModels(selected.length === models.length ? undefined : [...selected]);
  await settings.flush();
  const reload = await confirmWorkspaceAction(
    ctx,
    "Model scope saved",
    "Reload Pi resources now?",
    "Reload",
  );
  if (reload) await ctx.reload();
}

async function exportSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rawPath: string,
): Promise<void> {
  const sessionFile = requireSessionFile(ctx);
  const requested =
    rawPath ||
    (await inputWorkspaceValue(ctx, {
      title: "Export session",
      prompt: "Path ending in .jsonl exports the raw session; other paths export HTML.",
      placeholder: "pi-session.html",
    }));
  if (requested === undefined) return;
  const target = resolve(
    ctx.cwd,
    requested || `pi-session-${basename(sessionFile, ".jsonl")}.html`,
  );
  await mkdir(dirname(target), { recursive: true });
  if (target.endsWith(".jsonl")) {
    await copyFile(sessionFile, target);
  } else {
    await exportHtmlWithPi(pi, sessionFile, target);
  }
  ctx.ui.notify(`Session exported to ${target}`, "info");
}

async function importSession(ctx: ExtensionCommandContext, rawPath: string): Promise<void> {
  const requested =
    rawPath ||
    (await inputWorkspaceValue(ctx, {
      title: "Import session",
      prompt: "Select a Pi JSONL session file.",
      placeholder: "/path/to/session.jsonl",
    }));
  if (!requested) return;
  const source = resolve(ctx.cwd, requested);
  const confirmed = await confirmWorkspaceAction(
    ctx,
    "Import session",
    `Replace the current session with ${source}?`,
    "Import",
  );
  if (!confirmed) return;
  const sessionDir = getWritableSessionManager(ctx).getSessionDir();
  await mkdir(sessionDir, { recursive: true });
  const destination = join(sessionDir, basename(source));
  if (resolve(destination) !== source) await copyFile(source, destination);
  await ctx.switchSession(destination);
}

async function shareSession(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const sessionFile = requireSessionFile(ctx);
  const workDir = join(tmpdir(), `phenix-share-${Date.now()}`);
  const htmlPath = join(workDir, "session.html");
  await mkdir(workDir, { recursive: true });
  try {
    await runWorkspaceActivity(ctx, {
      title: "Share session",
      lines: ["Exporting session..."],
      run: async (activity) => {
        await exportHtmlWithPi(pi, sessionFile, htmlPath);
        activity.setLines(["Export complete", "Creating secret GitHub gist..."]);
        const result = await pi.exec("gh", ["gist", "create", htmlPath], { cwd: workDir });
        if (result.code !== 0) throw new Error(result.stderr || "Failed to create gist");
        const url = result.stdout.trim();
        if (!url) throw new Error("GitHub CLI returned no gist URL");
        await copyToClipboard(url);
        activity.setLines(["Secret gist created", url, "URL copied to clipboard"]);
      },
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function copyLastAssistantMessage(ctx: ExtensionContext): Promise<void> {
  const entries = ctx.sessionManager.getBranch();
  const entry = [...entries]
    .reverse()
    .find(
      (candidate) => candidate.type === "message" && candidate.message.role === "assistant",
    );
  if (!entry || entry.type !== "message") throw new Error("No assistant message to copy");
  const text = extractMessageText(entry.message.content);
  if (!text) throw new Error("Last assistant message contains no text");
  await copyToClipboard(text);
  ctx.ui.notify("Copied last assistant message", "info");
}

async function setSessionName(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  argument: string,
): Promise<void> {
  const value =
    argument ||
    (await inputWorkspaceValue(ctx, {
      title: "Session name",
      initialValue: pi.getSessionName() ?? "",
      placeholder: "descriptive session name",
    }));
  if (value === undefined) return;
  const name = value.trim();
  pi.setSessionName(name);
  ctx.ui.notify(name ? `Session named ${name}` : "Session name cleared", "info");
}

async function showSessionInfo(ctx: ExtensionContext): Promise<void> {
  const header = ctx.sessionManager.getHeader();
  const entries = ctx.sessionManager.getEntries();
  const usage = ctx.getContextUsage();
  await showWorkspaceDocument(ctx, {
    title: "Session",
    lines: [
      `Name: ${ctx.sessionManager.getSessionName() ?? "unnamed"}`,
      `ID: ${ctx.sessionManager.getSessionId()}`,
      `File: ${ctx.sessionManager.getSessionFile() ?? "in-memory"}`,
      `Working directory: ${ctx.sessionManager.getCwd()}`,
      `Created: ${header?.timestamp ?? "unknown"}`,
      `Entries: ${entries.length}`,
      `Leaf: ${ctx.sessionManager.getLeafId() ?? "none"}`,
      `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
      `Context: ${formatContextUsage(usage)}`,
    ],
  });
}

async function showChangelog(ctx: ExtensionContext): Promise<void> {
  const path = join(getPackageDir(), "CHANGELOG.md");
  const text = await readFile(path, "utf8");
  await showWorkspaceDocument(ctx, {
    title: `Pi ${VERSION} changelog`,
    lines: text.split("\n"),
  });
}

async function showHotkeys(ctx: ExtensionContext): Promise<void> {
  const customPath = join(getAgentDir(), "keybindings.json");
  let custom = "";
  try {
    custom = await readFile(customPath, "utf8");
  } catch {}
  await showWorkspaceDocument(ctx, {
    title: "Hotkeys",
    lines: [
      "Workspace",
      "  h / l             move between panes",
      "  j / k             move within the focused pane",
      "  Enter / Space     activate",
      "  Ctrl+L            model picker",
      "",
      "Pi",
      "  Escape            cancel or abort",
      "  Ctrl+C            clear input; twice to exit",
      "  Ctrl+D            exit with empty input",
      "  Shift+Tab         cycle thinking level",
      "  Ctrl+P            cycle model",
      "  Ctrl+O            expand/collapse tool output",
      "  Ctrl+T            show/hide thinking blocks",
      "  Ctrl+G            external editor",
      "  Ctrl+X            copy last message",
      "  Alt+Enter         queue follow-up",
      ...(custom ? ["", `Custom bindings (${customPath})`, ...custom.split("\n")] : []),
    ],
  });
}

async function forkSession(ctx: ExtensionCommandContext): Promise<void> {
  const messages = ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "user");
  const selected = await pickWorkspaceItem(ctx, {
    title: "Fork from user message",
    items: messages.map((entry, index) => ({
      id: entry.id,
      label: extractMessageText(entry.message.content) || `User message ${index + 1}`,
      detail: entry.timestamp,
      value: entry.id,
    })),
    emptyMessage: "No user messages to fork from",
  });
  if (selected) await ctx.fork(selected);
}

async function cloneSession(ctx: ExtensionCommandContext): Promise<void> {
  const leaf = ctx.sessionManager.getLeafId();
  if (!leaf) throw new Error("Nothing to clone yet");
  const confirmed = await confirmWorkspaceAction(
    ctx,
    "Clone session",
    "Create a new session at the current leaf?",
    "Clone",
  );
  if (confirmed) await ctx.fork(leaf, { position: "at" });
}

async function navigateSessionTree(ctx: ExtensionCommandContext): Promise<void> {
  const items: WorkspaceSelectDialogItem<string>[] = [];
  const visit = (
    nodes: ReturnType<ExtensionContext["sessionManager"]["getTree"]>,
    depth: number,
  ): void => {
    for (const node of nodes) {
      items.push({
        id: node.entry.id,
        label: `${"  ".repeat(depth)}${node.label ?? summarizeEntry(node.entry)}`,
        detail: node.entry.timestamp,
        current: node.entry.id === ctx.sessionManager.getLeafId(),
        value: node.entry.id,
      });
      visit(node.children, depth + 1);
    }
  };
  visit(ctx.sessionManager.getTree(), 0);
  const target = await pickWorkspaceItem(ctx, {
    title: "Session tree",
    items,
    emptyMessage: "Session tree is empty",
  });
  if (!target || target === ctx.sessionManager.getLeafId()) return;
  const summaryMode = await pickWorkspaceItem(ctx, {
    title: "Navigate branch",
    items: [
      { id: "none", label: "No summary", value: "none" },
      { id: "summary", label: "Summarize abandoned branch", value: "summary" },
      { id: "custom", label: "Summarize with custom instructions", value: "custom" },
    ],
  });
  if (!summaryMode) return;
  let customInstructions: string | undefined;
  if (summaryMode === "custom") {
    customInstructions = await inputWorkspaceValue(ctx, {
      title: "Branch summary instructions",
      placeholder: "What should the summary preserve?",
    });
    if (customInstructions === undefined) return;
  }
  await ctx.navigateTree(target, {
    summarize: summaryMode !== "none",
    customInstructions,
  });
}

async function configureTrust(ctx: ExtensionCommandContext): Promise<void> {
  const parent = dirname(ctx.cwd);
  const choice = await pickWorkspaceItem(ctx, {
    title: "Project trust",
    items: [
      {
        id: "trust",
        label: "Trust this project",
        detail: ctx.cwd,
        value: { path: ctx.cwd, decision: true },
      },
      ...(parent !== ctx.cwd
        ? [
            {
              id: "parent",
              label: "Trust parent folder",
              detail: parent,
              value: { path: parent, decision: true },
            },
          ]
        : []),
      {
        id: "deny",
        label: "Do not trust this project",
        detail: ctx.cwd,
        value: { path: ctx.cwd, decision: false },
      },
      {
        id: "clear",
        label: "Clear saved decision",
        detail: ctx.cwd,
        value: { path: ctx.cwd, decision: null },
      },
    ],
  });
  if (!choice) return;
  new ProjectTrustStore(getAgentDir()).set(choice.path, choice.decision);
  const reload = await confirmWorkspaceAction(
    ctx,
    "Trust decision saved",
    "Reload Pi resources now?",
    "Reload",
  );
  if (reload) await ctx.reload();
}

async function loginProvider(ctx: ExtensionContext, providerArgument: string): Promise<void> {
  const runtime = getModelRuntime(ctx);
  await runtime.getAvailable();
  const providers = runtime.getProviders().flatMap((provider) => {
    const items: Array<{
      id: string;
      providerId: string;
      providerName: string;
      authType: AuthType;
      label: string;
      detail: string;
    }> = [];
    if (provider.auth.oauth) {
      items.push({
        id: `${provider.id}:oauth`,
        providerId: provider.id,
        providerName: provider.name,
        authType: "oauth",
        label: provider.name,
        detail: "account / OAuth",
      });
    }
    if (provider.auth.apiKey) {
      items.push({
        id: `${provider.id}:api_key`,
        providerId: provider.id,
        providerName: provider.name,
        authType: "api_key",
        label: provider.name,
        detail: "API key",
      });
    }
    return items;
  });
  const normalized = providerArgument.trim().toLowerCase();
  const matches = normalized
    ? providers.filter(
        (item) =>
          item.providerId.toLowerCase() === normalized ||
          item.providerName.toLowerCase() === normalized,
      )
    : providers;
  const selected =
    matches.length === 1
      ? matches[0]
      : await pickWorkspaceItem(ctx, {
          title: "Login provider",
          items: matches.map((item) => ({ ...item, value: item })),
          emptyMessage: normalized
            ? `No login provider matching ${providerArgument}`
            : "No login providers available",
        });
  if (!selected) return;

  await runWorkspaceActivity(ctx, {
    title: `Login · ${selected.providerName}`,
    lines: [
      `Starting ${selected.authType === "oauth" ? "account" : "API key"} authentication...`,
    ],
    run: async (activity) => {
      await runtime.login(selected.providerId, selected.authType, {
        signal: activity.signal,
        prompt: (prompt) => handleAuthPrompt(ctx, prompt),
        notify: (event) => renderAuthEvent(activity, event),
      });
      await runtime.getAvailable();
      activity.setLines([`Authenticated with ${selected.providerName}`]);
    },
  });
  ctx.ui.notify(`Authenticated with ${selected.providerName}`, "info");
}

async function logoutProvider(ctx: ExtensionContext, providerArgument: string): Promise<void> {
  const runtime = getModelRuntime(ctx);
  const credentials = await runtime.listCredentials();
  const normalized = providerArgument.trim().toLowerCase();
  const options = credentials
    .map((credential) => ({
      id: credential.providerId,
      label: runtime.getProvider(credential.providerId)?.name ?? credential.providerId,
      detail: credential.type,
      value: credential.providerId,
    }))
    .filter(
      (item) =>
        !normalized ||
        item.id.toLowerCase() === normalized ||
        item.label.toLowerCase() === normalized,
    );
  const providerId =
    options.length === 1
      ? options[0]?.value
      : await pickWorkspaceItem(ctx, {
          title: "Logout provider",
          items: options,
          emptyMessage: "No stored credentials",
        });
  if (!providerId) return;
  const confirmed = await confirmWorkspaceAction(
    ctx,
    "Remove credentials",
    `Remove the stored credential for ${providerId}?`,
    "Logout",
  );
  if (!confirmed) return;
  await runtime.logout(providerId);
  ctx.ui.notify(`Removed stored credentials for ${providerId}`, "info");
}

async function newSession(ctx: ExtensionCommandContext): Promise<void> {
  const confirmed = await confirmWorkspaceAction(
    ctx,
    "New session",
    "Start a fresh session?",
    "Start new session",
  );
  if (confirmed) await ctx.newSession();
}

async function compactSession(ctx: ExtensionContext, argument: string): Promise<void> {
  const instructions =
    argument ||
    (await inputWorkspaceValue(ctx, {
      title: "Compact context",
      prompt: "Optional instructions for what the compacted summary must retain.",
      placeholder: "Leave empty for default compaction",
    }));
  if (instructions === undefined) return;
  ctx.compact(instructions.trim() ? { customInstructions: instructions.trim() } : undefined);
  ctx.ui.notify("Compaction started", "info");
}

async function resumeSession(ctx: ExtensionCommandContext): Promise<void> {
  const sessions = await SessionManager.list(
    ctx.cwd,
    getWritableSessionManager(ctx).getSessionDir(),
  );
  const current = ctx.sessionManager.getSessionFile();
  const selected = await pickWorkspaceItem(ctx, {
    title: "Resume session",
    items: sessions.map((session) => ({
      id: session.path,
      label: session.name || session.firstMessage || session.id,
      detail: `${session.messageCount} messages · ${session.modified.toLocaleString()}`,
      searchText: `${session.cwd} ${session.allMessagesText}`,
      current: session.path === current,
      value: session.path,
    })),
    emptyMessage: "No saved sessions",
  });
  if (selected && selected !== current) await ctx.switchSession(selected);
}

async function reloadResources(ctx: ExtensionCommandContext): Promise<void> {
  const confirmed = await confirmWorkspaceAction(
    ctx,
    "Reload resources",
    "Reload keybindings, extensions, skills, prompts, themes, and context files?",
    "Reload",
  );
  if (!confirmed) return;
  await ctx.reload();
}

async function quitPi(ctx: ExtensionContext): Promise<void> {
  const confirmed = await confirmWorkspaceAction(
    ctx,
    "Quit Pi",
    "Close the current Pi process?",
    "Quit",
  );
  if (confirmed) ctx.shutdown();
}

async function handleAuthPrompt(ctx: ExtensionContext, prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    const value = await pickWorkspaceItem(ctx, {
      title: prompt.message,
      items: prompt.options.map((option) => ({
        id: option.id,
        label: option.label,
        detail: option.description,
        value: option.id,
      })),
    });
    if (value === undefined) throw new Error("Login cancelled");
    return value;
  }
  const value = await inputWorkspaceValue(ctx, {
    title: prompt.type === "manual_code" ? "Authentication code" : "Authentication",
    prompt: prompt.message,
    placeholder: prompt.placeholder,
    secret: prompt.type === "secret",
    signal: prompt.signal,
  });
  if (value === undefined) throw new Error("Login cancelled");
  return value;
}

function renderAuthEvent(activity: WorkspaceActivityController, event: AuthEvent): void {
  if (event.type === "auth_url") {
    activity.setLines([event.instructions ?? "Open this URL to authenticate:", event.url]);
  } else if (event.type === "device_code") {
    activity.setLines([
      "Open the verification page and enter the device code:",
      event.verificationUri,
      `Code: ${event.userCode}`,
    ]);
  } else if (event.type === "info") {
    activity.setLines([
      event.message,
      ...(event.links ?? []).map((link) =>
        `${link.label ? `${link.label}: ` : ""}${link.url}`,
      ),
    ]);
  } else {
    activity.setLines([event.message]);
  }
}

function getWritableSessionManager(ctx: ExtensionContext): SessionManager {
  return ctx.sessionManager as unknown as SessionManager;
}

function getModelRuntime(ctx: ExtensionContext): ModelRuntime {
  const registry = ctx.modelRegistry as unknown as { runtime?: ModelRuntime };
  if (!registry.runtime) throw new Error("The pinned Pi model runtime is unavailable");
  return registry.runtime;
}

function createSettings(ctx: ExtensionContext): SettingsManager {
  return SettingsManager.create(ctx.cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  });
}

function formatContextUsage(usage: ReturnType<ExtensionContext["getContextUsage"]>): string {
  if (!usage) return "unavailable";
  const tokens = usage.tokens === null ? "unknown" : usage.tokens.toLocaleString();
  const percent = usage.percent === null ? "" : ` (${Math.round(usage.percent)}%)`;
  return `${tokens}/${usage.contextWindow.toLocaleString()} tokens${percent}`;
}

function requireSessionFile(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("This in-memory session cannot be exported");
  return sessionFile;
}

async function exportHtmlWithPi(
  pi: ExtensionAPI,
  sessionFile: string,
  target: string,
): Promise<void> {
  const outputDir = dirname(target);
  await mkdir(outputDir, { recursive: true });
  const result = await pi.exec("pi", ["--export", sessionFile], { cwd: outputDir });
  if (result.code !== 0) throw new Error(result.stderr || "Pi HTML export failed");
  const generated = join(outputDir, `pi-session-${basename(sessionFile, ".jsonl")}.html`);
  if (resolve(generated) !== resolve(target)) await rename(generated, target);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function summarizeEntry(
  entry: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>[number],
): string {
  if (entry.type === "message") {
    const text = extractMessageText(entry.message.content).replace(/\s+/gu, " ").trim();
    return `${entry.message.role}: ${text || "message"}`;
  }
  if (entry.type === "compaction") return "compaction";
  if (entry.type === "branch_summary") return `branch summary: ${entry.summary}`;
  if (entry.type === "label") return `label: ${entry.label ?? "cleared"}`;
  return entry.type.replaceAll("_", " ");
}
