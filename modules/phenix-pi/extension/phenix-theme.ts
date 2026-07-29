import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PHENIX_THEME_NAME = "phenix-catppuccin-mocha";

type ThemeUi = Pick<ExtensionContext["ui"], "notify" | "setTheme">;

export function activatePhenixTheme(ui: ThemeUi): boolean {
  const result = ui.setTheme(PHENIX_THEME_NAME);
  if (result.success) return true;
  ui.notify(
    `Could not activate ${PHENIX_THEME_NAME}: ${result.error ?? "theme is unavailable"}`,
    "warning",
  );
  return false;
}
