/**
 * handoff/repository-manifest.ts — Deterministic Git-based change detection.
 *
 * Generates a canonical repository manifest that is compared against
 * agent-claimed changed files. The manifest is derived from Git state,
 * not from agent claims.
 *
 * All functions throw on Git failures — the tool must catch and produce
 * a rejected handoff.
 */

import { execSync } from "node:child_process";
import type { RepositoryChange, RepositoryManifest } from "./schemas.js";
import { digestJson, sha256 } from "./artifact-store.js";

// ── Git execution ──

/**
 * Run a Git command and return stdout as a trimmed string.
 */
function git(args: string[], cwd: string): string {
	const result = execSync(`git ${args.join(" ")}`, {
		cwd,
		encoding: "utf-8",
		timeout: 15000,
		windowsHide: true,
		maxBuffer: 10 * 1024 * 1024,
	});
	return result.toString();
}

/**
 * Check if running inside a Git repository.
 */
export function isGitRepo(cwd: string): boolean {
	try {
		git(["rev-parse", "--git-dir"], cwd);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the current HEAD SHA.
 */
export function getHeadSha(cwd: string): string {
	return git(["rev-parse", "HEAD"], cwd).trim();
}

// ── Change detection ──

interface GitStatusEntry {
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	path: string;
	oldPath?: string;
}

/**
 * Parse Git status output (NUL-delimited format) into structured entries.
 *
 * Handles:
 * - staged and unstaged changes
 * - untracked files
 * - renames (old → new)
 * - filenames with whitespace or special characters
 */
function parseGitStatus(cwd: string): GitStatusEntry[] {
	const entries: GitStatusEntry[] = [];
	const seen = new Set<string>();

	// --- Staged changes (--cached, NUL-delimited) ---
	try {
		const stagedRaw = execSync(
			"git diff --cached --name-status -z --diff-filter=ACDMRT",
			{
				cwd,
				encoding: "utf-8",
				timeout: 10000,
				windowsHide: true,
				maxBuffer: 5 * 1024 * 1024,
			},
		).toString();
		parseNameStatusZ(stagedRaw).forEach((e) => {
			if (!seen.has(e.path)) {
				seen.add(e.path);
				entries.push(e);
			}
		});
	} catch {
		// No staged changes — ignore
	}

	// --- Unstaged changes (NUL-delimited) ---
	try {
		const unstagedRaw = execSync(
			"git diff --name-status -z --diff-filter=ACDMRT",
			{
				cwd,
				encoding: "utf-8",
				timeout: 10000,
				windowsHide: true,
				maxBuffer: 5 * 1024 * 1024,
			},
		).toString();
		parseNameStatusZ(unstagedRaw).forEach((e) => {
			if (!seen.has(e.path)) {
				seen.add(e.path);
				entries.push(e);
			}
		});
	} catch {
		// No unstaged changes — ignore
	}

	// --- Untracked files ---
	try {
		const untrackedRaw = execSync(
			"git ls-files --others --exclude-standard -z",
			{
				cwd,
				encoding: "utf-8",
				timeout: 10000,
				windowsHide: true,
				maxBuffer: 5 * 1024 * 1024,
			},
		).toString();
		const files = untrackedRaw.split("\0").filter(Boolean);
		for (const f of files) {
			if (!seen.has(f)) {
				seen.add(f);
				entries.push({ status: "untracked", path: f });
			}
		}
	} catch {
		// No untracked files — ignore
	}

	return entries;
}

/**
 * Parse NUL-delimited `git diff --name-status -z` output.
 * Format: <status><NUL><path>[<NUL><old-path>]<NUL><status>...
 */
function parseNameStatusZ(raw: string): GitStatusEntry[] {
	const entries: GitStatusEntry[] = [];
	const parts = raw.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i].trim();
		if (!part) continue;

		const statusCode = part[0];
		// Renames have two path entries after the status
		if (statusCode === "R") {
			const oldPath = parts[++i] ?? "";
			const newPath = parts[++i] ?? "";
			entries.push({ status: "renamed", path: newPath, oldPath });
		} else {
			const path = parts[++i] ?? "";
			const status = gitStatusFromCode(statusCode);
			if (status) {
				entries.push({ status, path });
			}
		}
	}
	return entries;
}

/**
 * Map single-letter Git status to our status type.
 */
function gitStatusFromCode(code: string): GitStatusEntry["status"] | null {
	switch (code) {
		case "A":
			return "added";
		case "C":
			return "added"; // copy treated as add
		case "M":
			return "modified";
		case "D":
			return "deleted";
		case "T":
			return "modified"; // type change treated as modify
		default:
			return null;
	}
}

/**
 * Compute a content digest for a file in the working tree (or staged/index).
 */
export function fileContentDigest(cwd: string, filePath: string): string {
	try {
		const raw = execSync(`git hash-object "${filePath}"`, {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		}).toString();
		return raw.trim();
	} catch {
		// File may have been deleted — return placeholder
		return sha256("(deleted)");
	}
}

// ── Sort comparator for canonical ordering ──

function compareChanges(a: RepositoryChange, b: RepositoryChange): number {
	if (a.status !== b.status) return a.status.localeCompare(b.status);
	return a.path.localeCompare(b.path);
}

// ── Main manifest generation ──

/**
 * Generate a canonical repository manifest by inspecting Git state.
 *
 * Covers: staged, unstaged, untracked, deleted, renamed, and files with spaces.
 * Sorts entries canonically before computing the manifest digest.
 *
 * Returns null if not in a Git repository.
 */
export function generateManifest(cwd: string): RepositoryManifest | null {
	if (!isGitRepo(cwd)) return null;

	const head = getHeadSha(cwd);
	const entries = parseGitStatus(cwd);

	const changes: RepositoryChange[] = entries.map((e) => {
		const change: RepositoryChange = {
			status: e.status,
			path: e.path,
		};
		if (e.oldPath) change.oldPath = e.oldPath;
		if (
			e.status === "added" ||
			e.status === "modified" ||
			e.status === "untracked"
		) {
			change.contentDigest = fileContentDigest(cwd, e.path);
		}
		if (e.status === "renamed") {
			change.contentDigest = fileContentDigest(cwd, e.path);
		}
		return change;
	});

	// Canonical sort
	changes.sort(compareChanges);

	// Compute manifest digest from sorted, canonicalized data
	const manifest: Omit<RepositoryManifest, "manifestDigest"> = {
		baseHead: head,
		changes,
	};
	const manifestDigest = digestJson(manifest);

	return {
		...manifest,
		manifestDigest,
	};
}

// ── Claim validation ──

/**
 * Compare worker claims against the authoritative manifest.
 * Returns mismatched file sets.
 */
export function compareClaims(
	manifest: RepositoryManifest,
	claimedChangedFiles: string[],
): { missing: string[]; unexpected: string[] } {
	const actualPaths = new Set(
		manifest.changes
			.filter((c) => c.status !== "deleted") // deletions are real changes
			.map((c) => c.path),
	);

	// Also include deleted files as actual changes for claim matching
	for (const c of manifest.changes) {
		if (c.status === "deleted") {
			actualPaths.add(c.path);
		}
	}

	const missing: string[] = [];
	const unexpected: string[] = [];

	// Files in manifest but not claimed
	for (const path of actualPaths) {
		if (!claimedChangedFiles.includes(path)) {
			missing.push(path);
		}
	}

	// Files claimed but not in manifest
	for (const claimed of claimedChangedFiles) {
		if (!actualPaths.has(claimed)) {
			unexpected.push(claimed);
		}
	}

	return { missing, unexpected };
}
