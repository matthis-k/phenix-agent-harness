import { pathToFileURL } from "node:url";

import { isObject, readJson, writeJsonIfChanged } from "./managed-json.mjs";

function modelId(value) {
  return isObject(value) && typeof value.id === "string" ? value.id : undefined;
}

function mergeModels(current, defaults) {
  const managed = new Map(defaults.map((model) => [modelId(model), model]));
  const seen = new Set();
  const merged = current.map((model) => {
    const id = modelId(model);
    const required = id ? managed.get(id) : undefined;
    if (!required) return model;
    seen.add(id);
    return isObject(model) && isObject(required) ? { ...model, ...required } : required;
  });

  for (const model of defaults) {
    const id = modelId(model);
    if (!id || seen.has(id)) continue;
    merged.push(model);
  }

  return merged;
}

export function mergeModelDefaults(current, defaults) {
  const output = isObject(current) ? structuredClone(current) : {};
  const defaultProviders =
    isObject(defaults) && isObject(defaults.providers) ? defaults.providers : {};
  const currentProviders = isObject(output.providers) ? output.providers : {};
  output.providers = currentProviders;

  for (const [providerId, defaultProvider] of Object.entries(defaultProviders)) {
    if (!isObject(defaultProvider)) continue;

    const currentProvider = isObject(currentProviders[providerId])
      ? currentProviders[providerId]
      : {};
    const mergedProvider = { ...currentProvider, ...defaultProvider };
    const currentModels = Array.isArray(currentProvider.models) ? currentProvider.models : [];
    const defaultModels = Array.isArray(defaultProvider.models) ? defaultProvider.models : [];
    mergedProvider.models = mergeModels(currentModels, defaultModels);
    currentProviders[providerId] = mergedProvider;
  }

  return output;
}

export async function mergeModelDefaultsFile(defaultsPath, targetPath) {
  const [defaults, current] = await Promise.all([
    readJson(defaultsPath, {}),
    readJson(targetPath, {}),
  ]);
  const merged = mergeModelDefaults(current, defaults);
  return writeJsonIfChanged(targetPath, current, merged);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [, , defaultsPath, targetPath] = process.argv;
  if (!defaultsPath || !targetPath) {
    console.error("usage: merge-model-defaults.mjs <defaults.json> <target.json>");
    process.exitCode = 2;
  } else {
    await mergeModelDefaultsFile(defaultsPath, targetPath);
  }
}
