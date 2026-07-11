/**
 * Phenix shared utilities — used across routing and subagent extensions.
 */

import fs from "node:fs";

/**
 * Deep-merge an overlay object into a base object.
 * Arrays are replaced wholesale, not merged element-by-element.
 * Null values in the overlay are preserved.
 */
export function mergeObjects<T extends Record<string, unknown>>(
  base: T,
  overlay: unknown,
): T {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = output[key];
    if (
      previous &&
      typeof previous === "object" &&
      !Array.isArray(previous) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      output[key] = mergeObjects(previous as Record<string, unknown>, value);
    } else {
      output[key] = value;
    }
  }
  return output as T;
}

/**
 * Read and parse a JSON file. Returns undefined if the file doesn't exist
 * or contains invalid JSON.
 */
export function readJson(candidate: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(candidate, "utf-8"));
  } catch {
    return undefined;
  }
}
