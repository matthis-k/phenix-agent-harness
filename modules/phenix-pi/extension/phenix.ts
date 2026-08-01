import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  createPhenixExtensionConfiguration,
  installPhenixExtensionSuite,
} from "../suite/phenix-extension-suite.ts";

/** Thin Pi adapter; concrete extension wiring belongs to the Phenix suite. */
export default async function phenix(pi: ExtensionAPI): Promise<void> {
  await installPhenixExtensionSuite(pi, createPhenixExtensionConfiguration());
}
