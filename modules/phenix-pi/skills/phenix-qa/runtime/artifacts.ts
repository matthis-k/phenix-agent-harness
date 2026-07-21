/**
 * Phenix QA — Artifact persistence.
 *
 * Creates and persists raw and normalized reports.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Resolve and create an artifact directory relative to the reviewed repository.
 * External paths require an explicit trusted caller override.
 */
export function ensureArtifactDir(
  cwd: string,
  dir: string,
  allowExternal = false,
): string {
  const root = resolve(cwd);
  const resolved = isAbsolute(dir) ? resolve(dir) : resolve(root, dir);
  const relation = relative(root, resolved);
  const escapes = relation === ".." || relation.startsWith("../") || isAbsolute(relation);
  if (escapes && !allowExternal) {
    throw new Error(`QA artifact directory escapes the reviewed repository: ${dir}`);
  }
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
export function writeJsonArtifact(artifactDir: string, name: string, data: unknown): string {
  const filePath = join(artifactDir, `${name}.json`);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return filePath;
}

/**
 * Write a text artifact.
 */
export function writeTextArtifact(artifactDir: string, name: string, content: string): string {
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
