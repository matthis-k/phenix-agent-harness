import assert from "node:assert/strict";
import test from "node:test";

import { createNeutralThemeAccess } from "../headless/neutral-theme.ts";

test("neutral theme preserves extension text without ANSI presentation ownership", () => {
  const themes = createNeutralThemeAccess();
  const theme = themes.current as unknown as {
    fg: (color: string, text: string) => string;
    bold: (text: string) => string;
    markdownTheme: { heading: (text: string) => string };
  };

  assert.equal(theme.fg("accent", "hello"), "hello");
  assert.equal(theme.bold("strong"), "strong");
  assert.equal(theme.markdownTheme.heading("title"), "title");
  assert.deepEqual(themes.list(), [{ name: "headless", path: undefined }]);
});

test("theme names remain Rust-owned while object replacement stays compatible", () => {
  const themes = createNeutralThemeAccess();
  assert.deepEqual(themes.set("catppuccin"), {
    success: false,
    error: "Theme is rendered by the Rust frontend: catppuccin",
  });
  assert.deepEqual(themes.set("headless"), { success: true });
});
