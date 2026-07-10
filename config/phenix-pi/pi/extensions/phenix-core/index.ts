import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// phenix-core provides model-ids shared between phenix-router.ts and
// phenix-routing-matrix.ts. All other types/routing/profiles were
// either dead code or duplicated in lib/phenix-routing-matrix.ts
// and have been removed.
export * from "./model-ids";

export default function phenixCore(_pi: ExtensionAPI) {
  // No-op. model-ids is imported directly by phenix-router.ts.
}
