export const PHENIX_THEME_NAME = "phenix-catppuccin-mocha";

export interface ThemeActivationPort {
  setTheme(theme: string): { readonly success: boolean; readonly error?: string };
  notify(message: string, level: "warning"): void;
}

export function activatePhenixTheme(ui: ThemeActivationPort): boolean {
  const result = ui.setTheme(PHENIX_THEME_NAME);
  if (result.success) return true;
  ui.notify(
    `Could not activate ${PHENIX_THEME_NAME}: ${result.error ?? "theme is unavailable"}`,
    "warning",
  );
  return false;
}
