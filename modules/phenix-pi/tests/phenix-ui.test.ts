import assert from "node:assert/strict";
import test from "node:test";

import type { TUI } from "@earendil-works/pi-tui";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";

import type { RunTree } from "../application/interfaces.ts";
import type { AnyDefinition } from "../domain/definition/definition.ts";
import type { DiagnosticSummary } from "../domain/diagnostics.ts";
import type { SessionProfile } from "../domain/run/model.ts";
import type { RunFact } from "../domain/run/observability.ts";
import type { RunId } from "../domain/shared.ts";
import type { ObservabilityTheme } from "../extension/observability-theme.ts";
import {
  PhenixUi,
  type PhenixUiSnapshot,
  parsePhenixUiTarget,
  parseSgrMouse,
} from "../extension/phenix-ui.ts";

const theme = {
  fg: (_tone: string, text: string) => text,
  bg: (_tone: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ObservabilityTheme;

const ANSI_TONES: Readonly<Record<string, string>> = {
  accent: "35",
  success: "32",
  error: "31",
  warning: "33",
  muted: "90",
  dim: "2",
  text: "37",
};
const ANSI_BACKGROUNDS: Readonly<Record<string, string>> = {
  selectedBg: "45",
  customMessageBg: "40",
  userMessageBg: "100",
};
const ansiTheme = {
  fg: (tone: string, text: string) => `\x1b[${ANSI_TONES[tone] ?? "37"}m${text}\x1b[0m`,
  bg: (tone: string, text: string) => `\x1b[${ANSI_BACKGROUNDS[tone] ?? "40"}m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as ObservabilityTheme;

test("parses Phenix UI view targets", () => {
  assert.deepEqual(parsePhenixUiTarget(""), { view: "status" });
  assert.deepEqual(parsePhenixUiTarget("runs run-123"), {
    view: "runs",
    selector: "run-123",
  });
  assert.deepEqual(parsePhenixUiTarget("catalog qa"), {
    view: "catalog",
    selector: "qa",
  });
  assert.equal(parsePhenixUiTarget("facts extra"), undefined);
  assert.equal(parsePhenixUiTarget("unknown"), undefined);
});

test("parses SGR mouse input", () => {
  assert.deepEqual(parseSgrMouse("\x1b[<0;12;4M"), {
    button: 0,
    x: 12,
    y: 4,
    release: false,
  });
  assert.deepEqual(parseSgrMouse("\x1b[<65;20;9M"), {
    button: 65,
    x: 20,
    y: 9,
    release: false,
  });
  assert.equal(parseSgrMouse("\x1b[A"), undefined);
});

test("unified UI fills the terminal and preserves no-wrap rows", () => {
  const tui = fakeTui(18);
  const ui = createUi(tui, { view: "catalog", selector: "qa" });
  const lines = ui.render(90);

  assert.equal(lines.length, 18);
  assert.ok(lines.every((line) => visibleWidth(line) === 90));
  assert.match(lines.join("\n"), /qa/);
  assert.ok(tui.writes.includes("\x1b[?1000h\x1b[?1006h"));

  ui.dispose();
  assert.ok(tui.writes.includes("\x1b[?1000l\x1b[?1006l"));
});

test("keyboard and mouse switch unified UI views", () => {
  const tui = fakeTui(16);
  const ui = createUi(tui, { view: "status" });

  ui.handleInput("4");
  assert.match(ui.render(100)[1] ?? "", /4 Catalog/);
  assert.match(ui.render(100).join("\n"), /workflow/);

  ui.handleInput("\x1b[<0;30;2M");
  assert.match(ui.render(100)[1] ?? "", /2 Runs/);
  assert.ok(tui.renderRequests > 0);
});

test("hides redundant pane navigation for single-pane views", () => {
  const lines = createUi(fakeTui(18), { view: "status" }).render(100);

  assert.equal(lines.length, 18);
  assert.match(lines[2] ?? "", /Session/);
  assert.doesNotMatch(lines.join("\n"), /Overview|Tab pane|focus Overview/);
});

test("pins selected Catalog metadata beneath the definition list", () => {
  const lines = createUi(fakeTui(18), { view: "catalog", selector: "qa" }).render(100);
  const definitionRow = lines.findIndex((line) => /W qa/.test(line));
  const inspectorRow = lines.findIndex((line) => /Selected definition/.test(line));

  assert.ok(definitionRow >= 0);
  assert.ok(inspectorRow > definitionRow);
  assert.match(lines.join("\n"), /Validate the repository/);
  assert.match(lines.join("\n"), /2 nodes · 1 transition/);
  assert.match(lines.join("\n"), /entry start · 1000ms · parallel 1/);
});

test("opens a selected agent with Pi-native transcript rendering and toggles its diagram", async () => {
  const ui = createUi(fakeTui(20), { view: "runs", selector: "run-child" });

  ui.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  let output = ui.render(140).join("\n");
  assert.match(output, /Transcript/);
  assert.match(output, /Pi native transcript for session-child/);
  assert.match(output, /session: session-child/);

  ui.handleInput("v");
  output = ui.render(140).join("\n");
  assert.match(output, /Diagram/);
  assert.doesNotMatch(output, /Pi native transcript for session-child/);
});

test("Status opens an active agent directly in its native transcript", async () => {
  const ui = createUi(fakeTui(20), { view: "status" });

  ui.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  const output = ui.render(120).join("\n");
  assert.match(output, /Phenix · Runs/);
  assert.match(output, /Transcript/);
  assert.match(output, /Pi native transcript for session-child/);
});

test("uses centered background surfaces without redundant active markers", () => {
  const tui = fakeTui(18);
  const ui = createUi(tui, { view: "catalog", selector: "qa" }, ansiTheme);

  let lines = ui.render(100);
  assert.match(lines[0] ?? "", /Phenix · Catalog/);
  assert.ok(lines[1]?.includes("\x1b[45m"));
  assert.match(lines[1] ?? "", /4 Catalog/);
  assert.doesNotMatch(lines[1] ?? "", /[●○▶▷│┃]/);
  assert.ok(lines[2]?.includes("\x1b[45m"));
  assert.match(lines[2] ?? "", /Definitions/);
  assert.doesNotMatch(lines[2] ?? "", /[●○▶▷│┃]/);
  assert.ok(lines.join("\n").includes("\x1b[35mW\x1b[0m"));
  assert.ok(lines.join("\n").includes("\x1b[100m"));

  ui.handleInput("\t");
  lines = ui.render(100);
  assert.ok(lines[2]?.includes("\x1b[45m"));
  assert.match(lines[2] ?? "", /Preview/);
  assert.doesNotMatch(lines.join("\n"), /[▶▷]/);

  const facts = createUi(fakeTui(18), { view: "facts" }, ansiTheme).render(120).join("\n");
  assert.ok(facts.includes("\x1b[35mrun-started\x1b[0m"));
  assert.ok(facts.includes("\x1b[32m[observed]\x1b[0m"));
});

function createUi(
  tui: FakeTui,
  initial: {
    readonly view: "status" | "runs" | "facts" | "catalog";
    readonly selector?: string;
  },
  uiTheme: ObservabilityTheme = theme,
): PhenixUi {
  const snapshot = fixtureSnapshot();
  return new PhenixUi({
    tui,
    theme: uiTheme,
    initial,
    snapshot,
    load: async () => snapshot,
    loadTranscript: async (node) => {
      const component = new Container();
      component.addChild(
        new Text(`Pi native transcript for ${node.run.pi?.sessionId ?? "none"}`, 0, 0),
      );
      return {
        component,
        sessionId: node.run.pi?.sessionId ?? String(node.run.id),
        ...(node.run.pi?.sessionFile ? { sessionFile: node.run.pi.sessionFile } : {}),
      };
    },
    subscribe: () => () => undefined,
    onClose: () => undefined,
  });
}

interface FakeTui extends TUI {
  readonly renderRequests: number;
  readonly writes: readonly string[];
}

function fakeTui(rows: number): FakeTui {
  let renderRequests = 0;
  const writes: string[] = [];
  const tui = {
    terminal: {
      rows,
      columns: 120,
      write(data: string) {
        writes.push(data);
      },
    },
    get renderRequests() {
      return renderRequests;
    },
    get writes() {
      return writes;
    },
    requestRender() {
      renderRequests += 1;
    },
  };
  return tui as unknown as FakeTui;
}

function fixtureSnapshot(): PhenixUiSnapshot {
  const rootId = "run-root" as RunId;
  const childId = "run-child" as RunId;
  const tree = {
    root: {
      run: {
        id: rootId,
        kind: "root",
        definitionId: "root.session",
        input: {},
        outputSchemaId: "root.output",
        requestedAt: "2026-07-26T10:00:00.000Z",
        ownership: "attached",
        state: "running",
        revision: 1,
        compiled: {
          definitionId: "root.session",
          input: {},
          outputSchemaId: "root.output",
          tools: [],
          limits: { timeoutMs: 1_000 },
          capabilities: {
            invokableDefinitions: [],
            maxDepth: 8,
            mayDetach: true,
            maySend: true,
            mayCancelChildren: true,
          },
          invocation: { wait: "await" },
        },
        activeChildren: [childId],
      },
      children: [
        {
          run: {
            id: childId,
            parentId: rootId,
            kind: "agent",
            definitionId: "agent.scout",
            input: {},
            outputSchemaId: "scout.output",
            requestedAt: "2026-07-26T10:00:01.000Z",
            ownership: "attached",
            state: "running",
            revision: 1,
            pi: {
              sessionId: "session-child",
              sessionFile: "/tmp/session-child.jsonl",
            },
            compiled: {
              definitionId: "agent.scout",
              input: {},
              outputSchemaId: "scout.output",
              tools: ["read"],
              limits: { timeoutMs: 5_000 },
              capabilities: {
                invokableDefinitions: [],
                maxDepth: 1,
                mayDetach: false,
                maySend: false,
                mayCancelChildren: false,
              },
              invocation: { wait: "await" },
            },
            activeChildren: [],
          },
          activity: {
            phase: "reading",
            summary: "Inspecting workflow definitions",
            source: "observed",
            timestamp: "2026-07-26T10:00:02.000Z",
          },
          children: [],
        },
      ],
    },
  } as unknown as RunTree;
  const facts = [
    {
      timestamp: "2026-07-26T10:00:02.000Z",
      rootRunId: rootId,
      runId: childId,
      kind: "run-started",
      reliability: "observed",
      summary: "Scout started",
    },
  ] as unknown as readonly RunFact[];
  const diagnostics = {
    total: 0,
    artifacts: 0,
    counts: { trace: 0, info: 0, warning: 0, error: 0 },
  } satisfies DiagnosticSummary;
  const profile = {
    agent: "base",
    modelSet: "mixed",
    difficulty: "D1",
    budget: "medium",
  } satisfies SessionProfile;
  const definitions = [
    {
      id: "workflow.qa",
      kind: "workflow",
      title: "QA",
      description: "Validate the repository",
      input: { id: "qa.input" },
      output: { id: "qa.output" },
      graph: {
        entry: "start",
        nodes: [
          {
            kind: "invoke",
            id: "start",
            definition: { id: "agent.scout" },
            input: "qa.input",
            wait: "await",
          },
          { kind: "return", id: "done", output: "qa.output" },
        ],
        edges: [{ from: "start", to: "done" }],
      },
      limits: { timeoutMs: 1_000, maxNodeRuns: 2, maxParallelism: 1 },
    },
  ] as unknown as readonly AnyDefinition[];
  return {
    tree,
    facts,
    sequence: 2,
    profile,
    diagnostics,
    integrations: "5/5 integrations",
    definitions,
  };
}
