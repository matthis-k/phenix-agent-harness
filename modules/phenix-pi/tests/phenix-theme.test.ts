import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  activatePhenixTheme,
  PHENIX_THEME_NAME,
  type ThemeActivationPort,
} from "../extension/phenix-theme.ts";

const REQUIRED_COLOR_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "selectedBg",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
] as const;

interface ThemeDocument {
  readonly name: string;
  readonly vars: Readonly<Record<string, string | number>>;
  readonly colors: Readonly<Record<string, string | number>>;
  readonly export?: Readonly<Record<string, string | number>>;
}

interface PackageDocument {
  readonly pi: {
    readonly extensions: readonly string[];
    readonly themes: readonly string[];
  };
}

const THEME = readJson<ThemeDocument>("../themes/catppuccin-mocha.json");
const PACKAGE = readJson<PackageDocument>("../package.json");

test("registers the Mocha theme and activates it before the other Phenix extensions", () => {
  assert.deepEqual(PACKAGE.pi.themes, ["./themes/catppuccin-mocha.json"]);
  assert.equal(PACKAGE.pi.extensions[0], "./extension/theme-extension.ts");
  assert.equal(THEME.name, PHENIX_THEME_NAME);
});

test("defines the complete Pi theme contract from the Catppuccin Mocha palette", () => {
  for (const token of REQUIRED_COLOR_TOKENS) {
    assert.ok(Object.hasOwn(THEME.colors, token), `missing Pi color token ${token}`);
  }
  assert.equal(THEME.vars.base, "#1e1e2e");
  assert.equal(THEME.vars.mantle, "#181825");
  assert.equal(THEME.vars.crust, "#11111b");
  assert.equal(THEME.vars.text, "#cdd6f4");
  assert.equal(THEME.colors.accent, "mauve");
  assert.equal(THEME.colors.success, "green");
  assert.equal(THEME.colors.error, "red");
  assert.equal(THEME.colors.warning, "yellow");
  assert.equal(THEME.colors.thinkingMax, "red");
  assert.deepEqual(THEME.export, {
    pageBg: "crust",
    cardBg: "base",
    infoBg: "surface0",
  });

  for (const [token, value] of Object.entries(THEME.colors)) {
    if (typeof value !== "string" || value === "" || value.startsWith("#")) continue;
    assert.ok(Object.hasOwn(THEME.vars, value), `${token} references missing variable ${value}`);
  }
});

test("activates the Mocha theme through the UI boundary", () => {
  const selected: string[] = [];
  const notifications: string[] = [];
  const ui: ThemeActivationPort = {
    setTheme: (theme) => {
      selected.push(theme);
      return { success: true };
    },
    notify: (message) => notifications.push(message),
  };

  assert.equal(activatePhenixTheme(ui), true);
  assert.deepEqual(selected, [PHENIX_THEME_NAME]);
  assert.deepEqual(notifications, []);
});

test("reports a missing theme without hiding the startup failure", () => {
  const notifications: string[] = [];
  const ui: ThemeActivationPort = {
    setTheme: () => ({ success: false, error: "not loaded" }),
    notify: (message) => notifications.push(message),
  };

  assert.equal(activatePhenixTheme(ui), false);
  assert.deepEqual(notifications, [`Could not activate ${PHENIX_THEME_NAME}: not loaded`]);
});

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as T;
}
