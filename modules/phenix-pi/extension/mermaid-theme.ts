import type { ObservabilityTheme } from "./observability-theme.ts";

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
  const truecolorPrefix = "\x1b[38;2;";
  if (ansi.startsWith(truecolorPrefix) && ansi.endsWith("m")) {
    const channels = ansi.slice(truecolorPrefix.length, -1).split(";").map(Number);
    if (
      channels.length === 3 &&
      channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
    ) {
      return rgbHex(channels[0], channels[1], channels[2]);
    }
  }
  const indexedPrefix = "\x1b[38;5;";
  if (!ansi.startsWith(indexedPrefix) || !ansi.endsWith("m")) return undefined;
  const index = Number(ansi.slice(indexedPrefix.length, -1));
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
