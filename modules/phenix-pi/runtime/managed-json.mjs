import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonIfChanged(targetPath, current, merged) {
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
