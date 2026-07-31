import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerWorkspace from "./default-workspace-extension.ts";
import registerResultDisplay from "./result-display.ts";
import registerRuntime from "./root-extension.ts";
import registerTheme from "./theme-extension.ts";
import registerUserForms from "./user-form-extension.ts";
import registerVisualizationDisplay from "./visualization-display.ts";
import { withWorkspaceStandardBuiltins } from "./workspace/workspace-standard-builtin-api.ts";
import registerWorkspaceStatus from "./workspace-status-extension.ts";

/**
 * Public Phenix extension entrypoint.
 *
 * Internal domains remain independently implemented, but Pi observes one
 * extension boundary and one deterministic registration order.
 */
export default async function phenix(pi: ExtensionAPI): Promise<void> {
  registerTheme(pi);
  await registerRuntime(pi);
  registerWorkspaceStatus(pi);
  registerUserForms(pi);
  registerWorkspace(withWorkspaceStandardBuiltins(pi));
  registerResultDisplay(pi);
  registerVisualizationDisplay(pi);
}
