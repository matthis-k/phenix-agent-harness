import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ── Data types ──
interface CommSession {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

interface CommAgent {
  id: string;
  name: string;
  kind: string;
  status: string;
  metadata: Record<string, unknown>;
  created_at: string;
  session_id: string;
}

interface CommEvent {
  id: string;
  agent_id: string | null;
  task_id: string | null;
  kind: string;
  message: string;
  payload: Record<string, unknown>;
  created_at: string;
}

// ── MCP helper ──
async function commTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const jsonArgs = JSON.stringify(args).replace(/'/g, "'\\''");
  const cmd = `phenix-agent-comm-mcp tool ${tool} --args '${jsonArgs}'`;
  const { stdout } = await execAsync(cmd, { timeout: 10000 });
  return JSON.parse(stdout);
}

const VISIBLE_COUNT = 16;

// ── Fzf-like agent browser component ──
//
// Layout (fzf --layout=reverse style):
//   ┌─────────────────────────────────────────────────────────────┐
//   │ > search query                                               │
//   ├──────────────────────┬──────────────────────────────────────┤
//   │ ● agent1  kind      │ Agent Name                            │
//   │ > ● agent2  kind    │ ● busy  phenix-worker                 │
//   │   ● agent3  kind    │                                        │
//   │                     │ 14:32  event_kind  Event message...    │
//   │                     │ 14:35  event_kind  Another event...    │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   │                     │                                        │
//   ├──────────┬──────────┴───────────────────────────────────────┤
//   │ 5/12 agents  ↑↓ navigate • esc close • ctrl-r refresh        │
//   └──────────────────────────────────────────────────────────────┘
//
class SubagentSidebar implements Component {
  private tui: TUI;
  private theme: Theme;
  private done: () => void;
  private sessionId: string | undefined;

  private loading = true;
  private error: string | null = null;
  private searchQuery = "";

  private agents: CommAgent[] = [];
  private events: CommEvent[] = [];
  private selectedIndex = 0;
  private treeScroll = 0;

  constructor(tui: TUI, theme: Theme, done: () => void, sessionId?: string) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.sessionId = sessionId;
    this.loadAll();
  }

  private async loadAll() {
    try {
      this.loading = true;
      this.tui.requestRender();

      if (!this.sessionId) {
        // Fallback: load all open sessions and pick the most recent
        const sessions = (await commTool("comm_session_list", {})) as CommSession[];
        const openSessions = sessions
          .filter((s) => s.status === "open")
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        if (openSessions.length > 0) {
          this.sessionId = openSessions[0].id;
        }
      }

      if (this.sessionId) {
        const [agents, evs] = await Promise.all([
          commTool("comm_agent_list", { session_id: this.sessionId }) as Promise<CommAgent[]>,
          commTool("comm_event_list", { session_id: this.sessionId, limit: 200 }) as Promise<CommEvent[]>,
        ]);
        this.agents = agents;
        this.events = evs;
      } else {
        this.agents = [];
        this.events = [];
      }

      this.loading = false;
      this.selectedIndex = 0;
      this.treeScroll = 0;
      this.tui.requestRender();
    } catch (e) {
      this.loading = false;
      this.error = e instanceof Error ? e.message : String(e);
      this.tui.requestRender();
    }
  }

  private getFilteredAgents(): CommAgent[] {
    if (!this.searchQuery.trim()) return this.agents;
    const q = this.searchQuery.toLowerCase();
    return this.agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.kind.toLowerCase().includes(q) ||
        a.status.toLowerCase().includes(q),
    );
  }

  private getSelectedAgent(): CommAgent | undefined {
    return this.getFilteredAgents()[this.selectedIndex];
  }

  private getAgentEvents(agentId: string): CommEvent[] {
    return this.events
      .filter((e) => e.agent_id === agentId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  private statusColors(status: string): "success" | "warning" | "error" | "dim" {
    return status === "busy"
      ? "warning"
      : status === "offline"
        ? "error"
        : status === "available"
          ? "success"
          : "dim";
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done();
      return;
    }

    if (this.loading) return;

    if (matchesKey(data, Key.ctrl("r"))) {
      this.loadAll();
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.selectedIndex = 0;
        this.treeScroll = 0;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      const filtered = this.getFilteredAgents();
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        if (this.selectedIndex < this.treeScroll) {
          this.treeScroll = this.selectedIndex;
        }
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.down)) {
      const filtered = this.getFilteredAgents();
      if (this.selectedIndex < filtered.length - 1) {
        this.selectedIndex++;
        if (this.selectedIndex >= this.treeScroll + VISIBLE_COUNT) {
          this.treeScroll = this.selectedIndex - VISIBLE_COUNT + 1;
        }
        this.tui.requestRender();
      }
      return;
    }

    // Text input for search — reject control characters
    if (!/[\x00-\x1f\x7f]/.test(data)) {
      this.searchQuery += data;
      this.selectedIndex = 0;
      this.treeScroll = 0;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const totalW = width;
    const lines: string[] = [];

    // Width calculations:
    //   Full-width lines (search, hints):   │ innerW │   where innerW = totalW - 2
    //   Split lines (body):                 │ leftW │ rightW │   where leftW+rightW = totalW - 3
    const innerW = totalW - 2;
    const splitW = totalW - 3;
    const leftW = Math.max(14, Math.floor(splitW * 0.25));
    const rightW = Math.max(1, splitW - leftW);

    const border = (c: string) => th.fg("border", c);
    const padLeft = (s: string) => truncateToWidth(s, leftW, "...", true);
    const padRight = (s: string) => truncateToWidth(s, rightW, "...", true);
    const padFull = (s: string) => truncateToWidth(s, innerW, "...", true);

    // ── Top border ──
    lines.push(border("┌") + border("─".repeat(innerW)) + border("┐"));

    // ── Search line (full width) ──
    if (this.searchQuery) {
      const searchText = `> ${this.searchQuery}`;
      lines.push(
        border("│") + padFull(th.fg("accent", th.bold(searchText))) + border("│"),
      );
    } else {
      const prompt = th.fg("accent", th.bold("> "));
      const placeholder = th.fg("dim", "type to filter agents");
      lines.push(border("│") + padFull(prompt + placeholder) + border("│"));
    }

    // ── Divider between search and body ──
    lines.push(
      border("├") + border("─".repeat(leftW)) + border("┬") + border("─".repeat(rightW)) + border("┤"),
    );

    // ── Body ──
    if (this.loading) {
      for (let i = 0; i < VISIBLE_COUNT; i++) {
        const leftText = i === 0 ? th.fg("dim", " Loading...") : "";
        const rightText = i === 0 && this.sessionId
          ? th.fg("dim", ` session: ${truncateToWidth(this.sessionId, rightW - 1)}`)
          : "";
        lines.push(border("│") + padLeft(leftText) + border("│") + padRight(rightText) + border("│"));
      }
    } else if (this.error) {
      for (let i = 0; i < VISIBLE_COUNT; i++) {
        const leftText = i === 0 ? th.fg("error", ` ${this.error}`) : "";
        lines.push(border("│") + padLeft(leftText) + border("│") + padRight("") + border("│"));
      }
    } else {
      const filtered = this.getFilteredAgents();
      const selected = this.getSelectedAgent();
      const agentEvents = selected ? this.getAgentEvents(selected.id) : [];

      for (let i = 0; i < VISIBLE_COUNT; i++) {
        // ── Left pane: agent list ──
        let leftText = "";
        const agent = filtered[this.treeScroll + i];
        if (agent) {
          const globalIdx = this.treeScroll + i;
          const isSelected = globalIdx === this.selectedIndex;
          const prefix = isSelected ? th.fg("accent", "> ") : "  ";
          const dot = th.fg(this.statusColors(agent.status), "●");
          const kindShort = th.fg("dim", truncateToWidth(agent.kind.replace("phenix-", ""), 8));
          const nameMax = Math.max(1, leftW - visibleWidth(prefix) - 2 - visibleWidth(kindShort));
          const name = truncateToWidth(agent.name, nameMax);
          leftText = `${prefix}${dot} ${name} ${kindShort}`;
        } else if (filtered.length === 0 && i === 0) {
          leftText = th.fg(
            "dim",
            this.searchQuery ? " No matching agents." : " No agents in session.",
          );
        }

        // ── Right pane: preview of selected agent ──
        let rightText = "";
        if (selected) {
          if (i === 0) {
            // Agent name header
            rightText = th.fg("accent", th.bold(truncateToWidth(selected.name, rightW - 1)));
          } else if (i === 1) {
            // Status + kind
            rightText = `${th.fg(this.statusColors(selected.status), "●")} ${selected.status}  ${th.fg("dim", selected.kind.replace("phenix-", ""))}`;
          } else if (i === 2 && selected.metadata && Object.keys(selected.metadata).length > 0) {
            // Brief metadata on separator line
            const metaSample = Object.entries(selected.metadata).slice(0, 1);
            const metaText = metaSample
              .map(([k, v]) => `${k}: ${typeof v === "string" ? truncateToWidth(v, 20) : String(v)}`)
              .join(", ");
            rightText = th.fg("dim", truncateToWidth(metaText, rightW));
          } else if (i >= 3) {
            // Events
            const evIdx = i - 3;
            const ev = agentEvents[evIdx];
            if (ev) {
              const time = ev.created_at.slice(11, 19);
              const kindShort = truncateToWidth(ev.kind, 12);
              const msgMax = Math.max(1, rightW - 24);
              const msg = truncateToWidth(ev.message, msgMax);
              rightText = ` ${th.fg("dim", time)} ${th.fg("accent", kindShort)} ${msg}`;
            } else if (agentEvents.length === 0 && i === 3) {
              rightText = th.fg("dim", " No events for this agent.");
            }
          }
        } else if (filtered.length > 0 && i === 0) {
          rightText = th.fg("dim", "Select an agent to preview.");
        }

        lines.push(border("│") + padLeft(leftText) + border("│") + padRight(rightText) + border("│"));
      }
    }

    // ── Bottom hints border ──
    lines.push(
      border("├") + border("─".repeat(leftW)) + border("┴") + border("─".repeat(rightW)) + border("┤"),
    );

    // ── Hints line (full width) ──
    const filtered = this.getFilteredAgents();
    const hintParts: string[] = [
      th.fg("dim", `${filtered.length}/${this.agents.length} agents`),
      th.fg("border", " • "),
      th.fg("dim", "↑↓ navigate"),
    ];
    if (this.sessionId) {
      hintParts.push(th.fg("border", " • "));
      hintParts.push(th.fg("dim", "ctrl-r refresh"));
    }
    hintParts.push(th.fg("border", " • "));
    hintParts.push(th.fg("dim", "esc close"));
    const hint = hintParts.join("");

    lines.push(border("│") + padFull(hint) + border("│"));

    // ── Bottom border ──
    lines.push(border("└") + border("─".repeat(innerW)) + border("┘"));

    return lines;
  }

  invalidate(): void {}
}

// ── Extension entry ──
export default function (pi: ExtensionAPI) {
  pi.registerCommand("agents", {
    description: "Open the subagent browser (fzf-style tree + preview)",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => new SubagentSidebar(tui, theme, done, sessionId),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "85%",
            minWidth: 50,
            maxHeight: "95%",
            margin: { top: 1, bottom: 1 },
          },
        },
      );
    },
  });

  pi.registerShortcut(Key.ctrlShift("a"), {
    description: "Open subagent browser (fzf-style)",
    handler: async (ctx) => {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => new SubagentSidebar(tui, theme, done, sessionId),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "85%",
            minWidth: 50,
            maxHeight: "95%",
            margin: { top: 1, bottom: 1 },
          },
        },
      );
    },
  });
}
