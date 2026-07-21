/**
 * Phenix QA — Scope resolution.
 *
 * Resolves diff, files, module, repository, or architecture scope.
 */

import { isAbsolute, relative, resolve } from "node:path";
import type { ReviewScope, ScopeFiles } from "../contracts/contracts.ts";
import type { ProcessRunner } from "./types.ts";

/**
 * Resolve the set of scoped files from a ReviewScope definition.
 */
export async function resolveScopeFiles(
  scope: ReviewScope,
  cwd: string,
  runner: ProcessRunner,
): Promise<ScopeFiles> {
  switch (scope.kind) {
    case "diff":
      return resolveDiffScope(scope, cwd, runner);
    case "files":
      return resolveExplicitFiles(scope);
    case "module":
      return resolveModuleFiles(scope, cwd, runner);
    case "repository":
    case "architecture":
      return resolveAllFiles(cwd, runner);
    default:
      return { files: [], added: [], modified: [], renamed: [], deleted: [] };
  }
}

/**
 * Resolve diff scope files against a base revision.
 */
async function resolveDiffScope(
  scope: ReviewScope,
  cwd: string,
  runner: ProcessRunner,
): Promise<ScopeFiles> {
  // Check if this is even a git repo
  try {
    const checkResult = await runner.exec("git", ["rev-parse", "--git-dir"], {
      cwd,
      timeoutMs: 5_000,
    });
    if (checkResult.exitCode !== 0) {
      throw new Error("not a git repo");
    }
  } catch {
    // Fall back to all files if not a git repo
    return resolveAllFiles(cwd, runner);
  }

  const base = scope.baseRevision ?? (await resolveMergeBase(cwd, runner));
  const target = scope.targetRevision ?? "HEAD";

  // Get diff file list
  const diffArgs = ["diff", "--name-status", "-z", `${base}...${target}`];

  // Also include unstaged changes if worktree is dirty
  try {
    const result = await runner.exec("git", diffArgs, {
      cwd,
      timeoutMs: 30_000,
    });

    return parseDiffNameStatus(result.stdout, result.exitCode === 0);
  } catch {
    return resolveAllFiles(cwd, runner);
  }
}

/**
 * Resolve merge base against the default branch.
 */
async function resolveMergeBase(cwd: string, runner: ProcessRunner): Promise<string> {
  // Try to detect the default branch
  try {
    const result = await runner.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeoutMs: 5_000,
    });
    const branch = result.stdout.trim();

    // If on a branch, find merge base with origin/main or origin/master
    for (const defaultBranch of ["origin/main", "origin/master", "main", "master"]) {
      try {
        const mbResult = await runner.exec("git", ["merge-base", branch, defaultBranch], {
          cwd,
          timeoutMs: 10_000,
        });
        if (mbResult.exitCode === 0 && mbResult.stdout.trim()) {
          return mbResult.stdout.trim();
        }
      } catch {}
    }

    return "HEAD~1";
  } catch {
    return "HEAD~1";
  }
}

/**
 * Parse `git diff --name-status -z` output.
 */
function parseDiffNameStatus(output: string, _success: boolean): ScopeFiles {
  const added: string[] = [];
  const modified: string[] = [];
  const renamed: string[] = [];
  const deleted: string[] = [];
  const all: string[] = [];

  if (!output) {
    return { files: [], added: [], modified: [], renamed: [], deleted: [] };
  }

  const parts = output.split("\0").filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status || status.length < 1) continue;

    const code = status.charAt(0);

    if (code === "R" || code === "C") {
      // Rename/copy: status contains old and new file names with tab
      i++;
      const _oldName = parts[i] ?? "";
      i++;
      const newName = parts[i] ?? "";
      if (newName) {
        renamed.push(newName);
        all.push(newName);
      }
    } else if (code === "D") {
      i++;
      const name = parts[i] ?? "";
      if (name) deleted.push(name);
    } else {
      i++;
      const name = parts[i] ?? "";
      if (!name) continue;
      all.push(name);
      if (code === "A") {
        added.push(name);
      } else if (code === "M") {
        modified.push(name);
      } else {
        // Unmerged, type change, etc.
        modified.push(name);
      }
    }
  }

  return {
    files: all,
    added,
    modified,
    renamed,
    deleted,
  };
}

/**
 * Resolve explicit file list scope.
 */
function resolveExplicitFiles(scope: ReviewScope): ScopeFiles {
  const files = scope.files ?? [];
  return {
    files,
    added: [],
    modified: [...files],
    renamed: [],
    deleted: [],
  };
}

async function resolveModuleFiles(
  scope: ReviewScope,
  cwd: string,
  runner: ProcessRunner,
): Promise<ScopeFiles> {
  const all = await resolveAllFiles(cwd, runner);
  const requested = scope.module?.trim();
  if (!requested) return all;

  const relativeModule = relative(cwd, resolve(cwd, requested)).replaceAll("\\", "/");
  if (!relativeModule || relativeModule === ".") return all;
  if (relativeModule === ".." || relativeModule.startsWith("../") || isAbsolute(relativeModule)) {
    throw new Error(`QA module scope escapes the reviewed repository: ${requested}`);
  }

  const files = all.files.filter(
    (file) => file === relativeModule || file.startsWith(`${relativeModule}/`),
  );
  return {
    files,
    added: [],
    modified: [...files],
    renamed: [],
    deleted: [],
  };
}

/**
 * Resolve all tracked and non-ignored untracked files in the repository.
 */
async function resolveAllFiles(cwd: string, runner: ProcessRunner): Promise<ScopeFiles> {
  try {
    const result = await runner.exec(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, timeoutMs: 30_000 },
    );
    if (result.exitCode === 0) {
      const files = uniqueRepositoryFiles(result.stdout.split("\0"));
      return {
        files,
        added: [],
        modified: [...files],
        renamed: [],
        deleted: [],
      };
    }
  } catch {
    // Fall through to a bounded filesystem walk for non-git repositories.
  }

  const files = await listFilesystemFiles(cwd);
  return {
    files,
    added: [],
    modified: [...files],
    renamed: [],
    deleted: [],
  };
}

function uniqueRepositoryFiles(files: readonly string[]): string[] {
  return [
    ...new Set(
      files
        .map((file) => file.trim().replaceAll("\\", "/").replace(/^\.\//, ""))
        .filter((file) => file.length > 0 && file !== ".." && !file.startsWith("../")),
    ),
  ].sort();
}

async function listFilesystemFiles(cwd: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const files: string[] = [];
  const skipped = new Set([".git", ".direnv", ".devenv", "node_modules"]);

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && skipped.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(relative(cwd, absolute).replaceAll("\\", "/"));
      }
    }
  };

  await visit(cwd);
  return uniqueRepositoryFiles(files);
}

/**
 * Check if a file path should be ignored per configuration.
 */
export function isIgnoredPath(
  filePath: string,
  ignorePaths: readonly string[],
  generatedPatterns: readonly string[],
  vendorPaths: readonly string[],
): boolean {
  // Check literal path prefixes
  for (const ignore of ignorePaths) {
    if (filePath.startsWith(`${ignore}/`) || filePath === ignore) {
      return true;
    }
  }

  // Check generated patterns (glob-style)
  for (const pattern of generatedPatterns) {
    if (matchSimpleGlob(filePath, pattern)) {
      return true;
    }
  }

  // Check vendor paths
  for (const vendor of vendorPaths) {
    if (filePath.startsWith(vendor)) {
      return true;
    }
  }

  return false;
}

/**
 * Simple glob matching (no full glob library dependency).
 */
function matchSimpleGlob(filePath: string, pattern: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return filePath === pattern;

  let index = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined) return false;

    if (part === "") {
      // Just a wildcard - skip to the next literal part
      if (i === parts.length - 1) return true; // trailing wildcard
      const nextPart = parts[i + 1];
      if (nextPart === undefined) return true;

      index = filePath.indexOf(nextPart, index);
      if (index === -1) return false;
      i++; // consumed the next literal
      index += nextPart.length;
    } else {
      if (!filePath.startsWith(part, index)) return false;
      index += part.length;
    }
  }
  return index === filePath.length;
}

/**
 * Determine whether a finding is within the current diff change lines.
 */
export function isInChangedLines(
  filePath: string,
  line?: number,
  scopeFiles?: ScopeFiles,
): boolean {
  if (!scopeFiles) return false;
  if (!line) return scopeFiles.files.includes(filePath);
  return (
    scopeFiles.modified.includes(filePath) ||
    scopeFiles.added.includes(filePath) ||
    scopeFiles.renamed.includes(filePath)
  );
}
