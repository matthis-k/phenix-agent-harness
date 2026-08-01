import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ExtensionModule<TServices> {
  readonly id: string;
  readonly requires?: readonly string[];
  register(pi: ExtensionAPI, services: TServices): void | Promise<void>;
}

export interface ExtensionSuite<TServices> {
  readonly services: TServices;
  readonly modules: readonly ExtensionModule<TServices>[];
}

export function defineExtensionSuite<TServices>(
  suite: ExtensionSuite<TServices>,
): ExtensionSuite<TServices> {
  orderExtensionModules(suite.modules);
  return Object.freeze({
    services: suite.services,
    modules: Object.freeze([...suite.modules]),
  });
}

export async function installExtensionSuite<TServices>(
  pi: ExtensionAPI,
  suite: ExtensionSuite<TServices>,
): Promise<void> {
  for (const module of orderExtensionModules(suite.modules)) {
    await module.register(pi, suite.services);
  }
}

/**
 * Stable topological ordering: dependency constraints are enforced while
 * otherwise preserving declaration order.
 */
export function orderExtensionModules<TServices>(
  modules: readonly ExtensionModule<TServices>[],
): readonly ExtensionModule<TServices>[] {
  const byId = new Map<string, ExtensionModule<TServices>>();
  for (const module of modules) {
    if (!module.id.trim()) throw new Error("Extension module id must not be empty");
    if (byId.has(module.id)) throw new Error(`Duplicate extension module: ${module.id}`);
    byId.set(module.id, module);
  }

  for (const module of modules) {
    for (const dependency of module.requires ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(`Extension module ${module.id} requires unknown module ${dependency}`);
      }
      if (dependency === module.id) {
        throw new Error(`Extension module ${module.id} cannot require itself`);
      }
    }
  }

  const installed = new Set<string>();
  const ordered: ExtensionModule<TServices>[] = [];
  while (ordered.length < modules.length) {
    const next = modules.find(
      (module) =>
        !installed.has(module.id) &&
        (module.requires ?? []).every((dependency) => installed.has(dependency)),
    );
    if (next) {
      installed.add(next.id);
      ordered.push(next);
      continue;
    }

    const blocked = modules
      .filter((module) => !installed.has(module.id))
      .map((module) => `${module.id} -> ${(module.requires ?? []).join(", ") || "none"}`)
      .join("; ");
    throw new Error(`Cyclic extension module dependencies: ${blocked}`);
  }
  return ordered;
}
