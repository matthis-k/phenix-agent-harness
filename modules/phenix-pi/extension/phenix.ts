import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installExtensionSuite } from "../framework/extension-suite.ts";
import { createPhenixExtensionSuite } from "../suite/phenix-extension-suite.ts";

/** Thin Pi adapter; concrete extension wiring belongs to the Phenix suite. */
export default async function phenix(pi: ExtensionAPI): Promise<void> {
  await installExtensionSuite(pi, createPhenixExtensionSuite());
}
