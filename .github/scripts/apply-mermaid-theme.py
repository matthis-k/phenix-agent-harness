from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected one match in {path}, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


Path("modules/phenix-pi/extension/mermaid-theme.ts").write_text(r'''import type { ObservabilityTheme } from "./observability-theme.ts";

export interface BeautifulMermaidPalette {
  readonly fg: string;
  readonly border: string;
  readonly line: string;
  readonly arrow: string;
  readonly accent: string;
  readonly corner: string;
  readonly junction: string;
}

export interface ResolvedBeautifulMermaidTheme {
  readonly colorMode: "ansi256" | "truecolor";
  readonly theme: BeautifulMermaidPalette;
}

const ANSI_16 = [
  "#000000",
  "#800000",
  "#008000",
  "#808000",
  "#000080",
  "#800080",
  "#008080",
  "#c0c0c0",
  "#808080",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#0000ff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;
const ANSI_CUBE = [0, 95, 135, 175, 215, 255] as const;

export function resolveBeautifulMermaidTheme(
  theme: ObservabilityTheme,
): ResolvedBeautifulMermaidTheme | undefined {
  const palette = {
    fg: ansiForegroundToHex(theme.getFgAnsi("text")),
    border: ansiForegroundToHex(theme.getFgAnsi("border")),
    line: ansiForegroundToHex(theme.getFgAnsi("borderMuted")),
    arrow: ansiForegroundToHex(theme.getFgAnsi("accent")),
    accent: ansiForegroundToHex(theme.getFgAnsi("accent")),
    corner: ansiForegroundToHex(theme.getFgAnsi("dim")),
    junction: ansiForegroundToHex(theme.getFgAnsi("borderAccent")),
  };
  if (Object.values(palette).some((value) => value === undefined)) return undefined;
  return {
    colorMode: theme.getColorMode() === "truecolor" ? "truecolor" : "ansi256",
    theme: palette as BeautifulMermaidPalette,
  };
}

export function ansiForegroundToHex(ansi: string): string | undefined {
  const truecolor = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
  if (truecolor) {
    const channels = truecolor.slice(1).map(Number);
    if (channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)) {
      return rgbHex(channels[0], channels[1], channels[2]);
    }
  }
  const indexed = /\x1b\[38;5;(\d+)m/.exec(ansi);
  if (!indexed) return undefined;
  const index = Number(indexed[1]);
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  return ansi256Hex(index);
}

function ansi256Hex(index: number): string {
  if (index < 16) return ANSI_16[index];
  if (index < 232) {
    const offset = index - 16;
    const red = ANSI_CUBE[Math.floor(offset / 36)];
    const green = ANSI_CUBE[Math.floor((offset % 36) / 6)];
    const blue = ANSI_CUBE[offset % 6];
    return rgbHex(red, green, blue);
  }
  const gray = 8 + (index - 232) * 10;
  return rgbHex(gray, gray, gray);
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
''')

Path("modules/phenix-pi/tests/mermaid-theme.test.ts").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";

import type { ObservabilityTheme } from "../extension/observability-theme.ts";
import { renderTerminalMermaid } from "../extension/mermaid-rendering.ts";
import {
  ansiForegroundToHex,
  resolveBeautifulMermaidTheme,
} from "../extension/mermaid-theme.ts";

function fakeTheme(
  mode: "truecolor" | "256color",
  colors: Readonly<Record<string, string>>,
): ObservabilityTheme {
  return {
    getColorMode: () => mode,
    getFgAnsi: (tone: string) => colors[tone] ?? "\x1b[39m",
  } as unknown as ObservabilityTheme;
}

const truecolorTheme = fakeTheme("truecolor", {
  text: "\x1b[38;2;205;214;244m",
  border: "\x1b[38;2;88;91;112m",
  borderMuted: "\x1b[38;2;69;71;90m",
  accent: "\x1b[38;2;137;180;250m",
  dim: "\x1b[38;2;108;112;134m",
  borderAccent: "\x1b[38;2;180;190;254m",
});

test("maps the active Pi truecolor theme to Beautiful Mermaid roles", () => {
  assert.deepEqual(resolveBeautifulMermaidTheme(truecolorTheme), {
    colorMode: "truecolor",
    theme: {
      fg: "#cdd6f4",
      border: "#585b70",
      line: "#45475a",
      arrow: "#89b4fa",
      accent: "#89b4fa",
      corner: "#6c7086",
      junction: "#b4befe",
    },
  });
});

test("converts Pi 256-color ANSI values into exact RGB theme colors", () => {
  assert.equal(ansiForegroundToHex("\x1b[38;5;67m"), "#5f87af");
  assert.equal(ansiForegroundToHex("\x1b[38;5;232m"), "#080808");
  assert.equal(ansiForegroundToHex("\x1b[38;5;255m"), "#eeeeee");
  assert.equal(ansiForegroundToHex("\x1b[39m"), undefined);
});

test("terminal Mermaid output uses the active Pi theme when supplied", () => {
  const rendered = renderTerminalMermaid("flowchart LR\n  A[Start] --> B[Done]", {
    compact: true,
    theme: truecolorTheme,
  });
  assert.match(rendered, /\x1b\[38;2;/);
  assert.match(rendered, /\x1b\[38;2;205;214;244m/);
});
''')

replace_once(
    "modules/phenix-pi/extension/mermaid-rendering.ts",
    'import { renderMermaidASCII } from "beautiful-mermaid";\n',
    'import { renderMermaidASCII } from "beautiful-mermaid";\n\nimport { resolveBeautifulMermaidTheme } from "./mermaid-theme.ts";\nimport type { ObservabilityTheme } from "./observability-theme.ts";\n',
)
replace_once(
    "modules/phenix-pi/extension/mermaid-rendering.ts",
    '  readonly color?: boolean;\n}',
    '  readonly color?: boolean;\n  readonly theme?: ObservabilityTheme;\n}',
)
replace_once(
    "modules/phenix-pi/extension/mermaid-rendering.ts",
    'export interface RunSequenceOptions {\n  readonly expanded?: boolean;\n}',
    'export interface RunSequenceOptions {\n  readonly expanded?: boolean;\n  readonly theme?: ObservabilityTheme;\n}',
)
replace_once(
    "modules/phenix-pi/extension/mermaid-rendering.ts",
    '  return renderMermaidASCII(normalized, {\n',
    '  const resolvedTheme = options.theme ? resolveBeautifulMermaidTheme(options.theme) : undefined;\n  return renderMermaidASCII(normalized, {\n',
)
replace_once(
    "modules/phenix-pi/extension/mermaid-rendering.ts",
    '    colorMode: options.color ? "auto" : "none",\n',
    '    colorMode: resolvedTheme?.colorMode ?? (options.color ? "auto" : "none"),\n    ...(resolvedTheme ? { theme: resolvedTheme.theme } : {}),\n',
)
replace_once(
    "modules/phenix-pi/extension/mermaid-rendering.ts",
    'export function renderCatalogDefinition(definition: AnyDefinition): string {',
    'export function renderCatalogDefinition(\n  definition: AnyDefinition,\n  options: Pick<TerminalMermaidOptions, "theme"> = {},\n): string {',
)
replace_once(
    "modules/phenix-pi/extension/mermaid-rendering.ts",
    '    lines.push("", renderTerminalMermaid(workflowDefinitionMermaid(definition), { compact: true }));',
    '    lines.push(\n      "",\n      renderTerminalMermaid(workflowDefinitionMermaid(definition), {\n        compact: true,\n        theme: options.theme,\n      }),\n    );',
)
replace_once(
    "modules/phenix-pi/extension/mermaid-rendering.ts",
    '  return renderTerminalMermaid(runTreeSequenceMermaid(tree, options), { compact: true });',
    '  return renderTerminalMermaid(runTreeSequenceMermaid(tree, options), {\n    compact: true,\n    theme: options.theme,\n  });',
)
replace_once(
    "modules/phenix-pi/extension/phenix-ui.ts",
    '      lines = renderRunTreeSequence({ root }, { expanded: true }).split("\\n");',
    '      lines = renderRunTreeSequence({ root }, { expanded: true, theme: this.theme }).split("\\n");',
)
replace_once(
    "modules/phenix-pi/extension/phenix-ui.ts",
    '      lines = renderCatalogDefinition(definition).split("\\n");',
    '      lines = renderCatalogDefinition(definition, { theme: this.theme }).split("\\n");',
)
