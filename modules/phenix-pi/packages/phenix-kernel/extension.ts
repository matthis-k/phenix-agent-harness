import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Kernel extension: publishes shared Phenix vocabulary for package consumers. */
export default function phenixKernel(_pi: ExtensionAPI): void {
  // Intentionally no runtime hooks: this package is the stable vocabulary layer.
}
