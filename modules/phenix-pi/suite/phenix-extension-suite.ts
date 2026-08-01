import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerWorkspace from "../extension/default-workspace-extension.ts";
import registerResultDisplay from "../extension/result-display.ts";
import registerRuntime from "../extension/root-extension.ts";
import registerTheme from "../extension/theme-extension.ts";
import registerUserForms from "../extension/user-form-extension.ts";
import registerVisualizationDisplay from "../extension/visualization-display.ts";
import { withWorkspaceStandardBuiltins } from "../extension/workspace/workspace-standard-builtin-api.ts";
import registerWorkspaceStatus from "../extension/workspace-status-extension.ts";

export type ExtensionRegistrar = (pi: ExtensionAPI) => void | Promise<void>;

/**
 * Concrete extension implementations remain configurable, but their lifecycle
 * and ordering are part of the Phenix integration contract rather than runtime
 * dependency data.
 */
export interface PhenixExtensionConfiguration {
  readonly theme: ExtensionRegistrar;
  readonly runtime: ExtensionRegistrar;
  readonly workspaceStatus: ExtensionRegistrar;
  readonly userForms: ExtensionRegistrar;
  readonly workspace: ExtensionRegistrar;
  readonly resultDisplay: ExtensionRegistrar;
  readonly visualizationDisplay: ExtensionRegistrar;
}

const defaultConfiguration: PhenixExtensionConfiguration = Object.freeze({
  theme: registerTheme,
  runtime: registerRuntime,
  workspaceStatus: registerWorkspaceStatus,
  userForms: registerUserForms,
  workspace: (pi: ExtensionAPI) => registerWorkspace(withWorkspaceStandardBuiltins(pi)),
  resultDisplay: registerResultDisplay,
  visualizationDisplay: registerVisualizationDisplay,
});

export function createPhenixExtensionConfiguration(
  overrides: Partial<PhenixExtensionConfiguration> = {},
): PhenixExtensionConfiguration {
  return Object.freeze({ ...defaultConfiguration, ...overrides });
}

/**
 * Install the fixed Phenix extension lifecycle. Configuration can replace any
 * concrete registrar, but cannot silently reorder initialization invariants.
 */
export async function installPhenixExtensionSuite(
  pi: ExtensionAPI,
  configuration: PhenixExtensionConfiguration = createPhenixExtensionConfiguration(),
): Promise<void> {
  await configuration.theme(pi);
  await configuration.runtime(pi);
  await configuration.workspaceStatus(pi);
  await configuration.userForms(pi);
  await configuration.workspace(pi);
  await configuration.resultDisplay(pi);
  await configuration.visualizationDisplay(pi);
}
