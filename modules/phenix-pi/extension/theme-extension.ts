import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { activatePhenixTheme } from "./phenix-theme.ts";

export default function themeExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode === "tui") activatePhenixTheme(ctx.ui);
  });
}
