import { pathToFileURL } from "node:url";

import { isObject, readJson, writeJsonIfChanged } from "./managed-json.mjs";

export function mergeMcpDefaults(current, defaults) {
  const output = isObject(current) ? structuredClone(current) : {};

  const defaultSettings =
    isObject(defaults) && isObject(defaults.settings) ? defaults.settings : {};
  const currentSettings = isObject(output.settings) ? output.settings : {};
  output.settings = { ...defaultSettings, ...currentSettings };

  const defaultServers =
    isObject(defaults) && isObject(defaults.mcpServers) ? defaults.mcpServers : {};
  const currentServers = isObject(output.mcpServers) ? output.mcpServers : {};
  output.mcpServers = currentServers;

  for (const [serverId, defaultServer] of Object.entries(defaultServers)) {
    if (!isObject(defaultServer)) continue;
    const currentServer = isObject(currentServers[serverId]) ? currentServers[serverId] : {};
    currentServers[serverId] = { ...currentServer, ...defaultServer };
  }

  return output;
}

export async function mergeMcpDefaultsFile(defaultsPath, targetPath) {
  const [defaults, current] = await Promise.all([
    readJson(defaultsPath, {}),
    readJson(targetPath, {}),
  ]);
  const merged = mergeMcpDefaults(current, defaults);
  return writeJsonIfChanged(targetPath, current, merged);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [, , defaultsPath, targetPath] = process.argv;
  if (!defaultsPath || !targetPath) {
    console.error("usage: merge-mcp-defaults.mjs <defaults.json> <target.json>");
    process.exitCode = 2;
  } else {
    await mergeMcpDefaultsFile(defaultsPath, targetPath);
  }
}
