import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiKeyCredential(value) {
  return isObject(value) && value.type === "api_key" && typeof value.key === "string";
}

/**
 * OpenCode Zen and OpenCode Go use the same OPENCODE_API_KEY credential, but
 * Pi stores interactive /login credentials under provider-specific keys.
 * Fill only a missing sibling entry; never overwrite explicit credentials.
 */
export function syncOpenCodeAuth(current) {
  const output = isObject(current) ? structuredClone(current) : {};
  const hasZen = Object.hasOwn(output, "opencode");
  const hasGo = Object.hasOwn(output, "opencode-go");
  const zen = output.opencode;
  const go = output["opencode-go"];

  if (!hasZen && isApiKeyCredential(go)) {
    output.opencode = structuredClone(go);
  } else if (!hasGo && isApiKeyCredential(zen)) {
    output["opencode-go"] = structuredClone(zen);
  }

  return output;
}

export async function syncOpenCodeAuthFile(path) {
  let current;
  try {
    current = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  const synced = syncOpenCodeAuth(current);
  const rendered = `${JSON.stringify(synced, null, 2)}\n`;
  const currentRendered = `${JSON.stringify(current, null, 2)}\n`;
  if (rendered === currentRendered) return false;

  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, rendered, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: sync-opencode-auth.mjs <auth.json>");
    process.exitCode = 2;
  } else {
    await syncOpenCodeAuthFile(path);
  }
}
