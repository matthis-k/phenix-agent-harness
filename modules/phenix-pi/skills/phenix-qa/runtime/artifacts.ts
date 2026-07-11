/**
 * Phenix QA — Artifact persistence.
 *
 * Creates and persists raw and normalized reports.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure the artifact directory exists.
 */
export function ensureArtifactDir(dir: string): string {
  const resolved = join(process.cwd(), dir);
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true });
  }
  return resolved;
}

/**
 * Write raw analyzer output to a timestamped artifact file.
 */
export function writeRawArtifact(
  artifactDir: string,
  analyzer: string,
  content: string,
  extension: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${analyzer}-${timestamp}.${extension}`;
  const filePath = join(artifactDir, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Write a JSON artifact.
 */
export function writeJsonArtifact(
  artifactDir: string,
  name: string,
  data: unknown,
): string {
  const filePath = join(artifactDir, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return filePath;
}

/**
 * Write a text artifact.
 */
export function writeTextArtifact(
  artifactDir: string,
  name: string,
  content: string,
): string {
  const filePath = join(artifactDir, `${name}.txt`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Read a text artifact.
 */
export function readTextArtifact(path: string): string {
  return readFileSync(path, "utf-8");
}
