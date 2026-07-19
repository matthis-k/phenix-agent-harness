/**
 * Phenix QA — Artifact persistence.
 *
 * Creates and persists raw and normalized reports.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Ensure the artifact directory exists and return its absolute path. */
export function ensureArtifactDir(dir: string): string {
  const resolved = resolve(dir);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

function artifactPath(artifactDir: string, filename: string): string {
  return join(ensureArtifactDir(artifactDir), filename);
}

/** Write raw analyzer output to a timestamped artifact file. */
export function writeRawArtifact(
  artifactDir: string,
  analyzer: string,
  content: string,
  extension: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = artifactPath(artifactDir, `${analyzer}-${timestamp}.${extension}`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Write a JSON artifact. */
export function writeJsonArtifact(artifactDir: string, name: string, data: unknown): string {
  const filePath = artifactPath(artifactDir, `${name}.json`);
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return filePath;
}

/** Write a text artifact. */
export function writeTextArtifact(artifactDir: string, name: string, content: string): string {
  const filePath = artifactPath(artifactDir, `${name}.txt`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/** Read a text artifact. */
export function readTextArtifact(path: string): string {
  return readFileSync(path, "utf-8");
}
