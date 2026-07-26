import assert from "node:assert/strict";
import test from "node:test";
import { renderTerminalMermaid } from "../extension/mermaid-rendering.ts";
import { ansiForegroundToHex, resolveBeautifulMermaidTheme } from "../extension/mermaid-theme.ts";
import type { ObservabilityTheme } from "../extension/observability-theme.ts";

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
  assert.ok(rendered.includes("\x1b[38;2;"));
  assert.ok(rendered.includes("\x1b[38;2;205;214;244m"));
});
