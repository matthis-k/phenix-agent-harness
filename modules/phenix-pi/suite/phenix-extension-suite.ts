import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerWorkspace from "../extension/default-workspace-extension.ts";
import registerResultDisplay from "../extension/result-display.ts";
import registerRuntime from "../extension/root-extension.ts";
import registerTheme from "../extension/theme-extension.ts";
import registerUserForms from "../extension/user-form-extension.ts";
import registerVisualizationDisplay from "../extension/visualization-display.ts";
import { withWorkspaceStandardBuiltins } from "../extension/workspace/workspace-standard-builtin-api.ts";
import registerWorkspaceStatus from "../extension/workspace-status-extension.ts";
import {
  defineExtensionSuite,
  type ExtensionModule,
  type ExtensionSuite,
} from "../framework/extension-suite.ts";

export type ExtensionRegistrar = (pi: ExtensionAPI) => void | Promise<void>;

export interface PhenixExtensionServices {
  readonly theme: ExtensionRegistrar;
  readonly runtime: ExtensionRegistrar;
  readonly workspaceStatus: ExtensionRegistrar;
  readonly userForms: ExtensionRegistrar;
  readonly workspace: ExtensionRegistrar;
  readonly resultDisplay: ExtensionRegistrar;
  readonly visualizationDisplay: ExtensionRegistrar;
}

const defaultServices: PhenixExtensionServices = Object.freeze({
  theme: registerTheme,
  runtime: registerRuntime,
  workspaceStatus: registerWorkspaceStatus,
  userForms: registerUserForms,
  workspace: (pi: ExtensionAPI) => registerWorkspace(withWorkspaceStandardBuiltins(pi)),
  resultDisplay: registerResultDisplay,
  visualizationDisplay: registerVisualizationDisplay,
});

const modules: readonly ExtensionModule<PhenixExtensionServices>[] = [
  module("theme", [], (services) => services.theme),
  module("runtime", ["theme"], (services) => services.runtime),
  module("workspace-status", ["runtime"], (services) => services.workspaceStatus),
  module("user-forms", ["runtime"], (services) => services.userForms),
  module("workspace", ["runtime", "user-forms"], (services) => services.workspace),
  module("result-display", ["runtime"], (services) => services.resultDisplay),
  module("visualization-display", ["result-display"], (services) => services.visualizationDisplay),
];

export function createPhenixExtensionSuite(
  overrides: Partial<PhenixExtensionServices> = {},
): ExtensionSuite<PhenixExtensionServices> {
  const services = Object.freeze({ ...defaultServices, ...overrides });
  return defineExtensionSuite({ services, modules });
}

function module(
  id: string,
  requires: readonly string[],
  select: (services: PhenixExtensionServices) => ExtensionRegistrar,
): ExtensionModule<PhenixExtensionServices> {
  return {
    id,
    requires,
    register: (pi, services) => select(services)(pi),
  };
}
