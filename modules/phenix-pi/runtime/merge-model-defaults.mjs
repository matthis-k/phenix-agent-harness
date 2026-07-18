import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function mergeModelDefaultsFile(defaultsPath, targetPath) {
  const [defaults, current] = await Promise.all([
    readJson(defaultsPath, {}),
    readJson(targetPath, {}),
  ]);
  const merged = mergeModelDefaults(current, defaults);
  const rendered = `${JSON.stringify(merged, null, 2)}\n`;
  const currentRendered = `${JSON.stringify(current, null, 2)}\n`;
  if (rendered === currentRendered) return false;

  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, rendered, { mode: 0o600 });
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);
  return true;
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
