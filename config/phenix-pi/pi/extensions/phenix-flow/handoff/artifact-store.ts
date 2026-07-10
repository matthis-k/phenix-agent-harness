/**
 * handoff/artifact-store.ts — Immutable file-backed typed artifact store.
 *
 * Artifacts are stored under `.phenix/runs/<run-id>/` with atomic writes,
 * content-addressed digests, and immutability guarantees.
 *
 * Requirements:
 * - Canonicalize JSON before hashing (sorted keys)
 * - SHA-256 digest for payload integrity
 * - Write through temporary file and atomic rename
 * - Never overwrite an existing artifact
 * - Reject duplicate IDs with different content
 * - Validate artifacts again when reading them
 */

import { createHash } from "node:crypto";
import {
	readFileSync,
	writeFileSync,
	renameSync,
	existsSync,
	mkdirSync,
	readdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import type { ArtifactEnvelope, HandoffSubmission } from "./schemas.js";
import { validateKind, validateIdentity } from "./schemas.js";

// ── Constants ──

const RUNS_DIR = ".phenix/runs";
const CANONICAL_ENCODING: "utf-8" = "utf-8";

// ── SHA-256 helpers ──

/**
 * Compute a SHA-256 hex digest of a string.
 */
export function sha256(content: string): string {
	return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Canonical JSON serialization: deterministic key ordering, no extra whitespace.
 */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(value, Object.keys(value as object).sort());
}

/**
 * Compute a SHA-256 digest of a canonicalized JSON value.
 */
export function digestJson(value: unknown): string {
	return sha256(canonicalJson(value));
}

// ── ID generation ──

let counter = 0;

/**
 * Generate a unique artifact ID from timestamp, counter, and random bits.
 * Format: <timestamp>-<counter>-<random-hex>
 */
export function generateArtifactId(): string {
	const ts = Date.now().toString(36);
	counter++;
	const rand = Math.random().toString(36).slice(2, 8);
	return `${ts}-${counter}-${rand}`;
}

// ── Path resolution ──

/**
 * Get the root directory for artifact storage.
 * Uses cwd as base, resolves to `<cwd>/.phenix/runs/<runId>`.
 */
export function runsDir(cwd: string): string {
	return resolve(cwd, RUNS_DIR);
}

export function runDir(cwd: string, runId: string): string {
	return resolve(runsDir(cwd), runId);
}

export function artifactsDir(cwd: string, runId: string): string {
	return resolve(runDir(cwd, runId), "artifacts");
}

export function manifestsDir(cwd: string, runId: string): string {
	return resolve(runDir(cwd, runId), "manifests");
}

export function runMetaPath(cwd: string, runId: string): string {
	return resolve(runDir(cwd, runId), "run.json");
}

export function artifactPath(
	cwd: string,
	runId: string,
	artifactId: string,
): string {
	return resolve(artifactsDir(cwd, runId), `${artifactId}.json`);
}

export function manifestPath(
	cwd: string,
	runId: string,
	digest: string,
): string {
	return resolve(manifestsDir(cwd, runId), `${digest}.json`);
}

// ── Store helpers ──

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

/**
 * Atomically write content to a file.
 * Writes to a temp file first, then atomically renames.
 */
function atomicWrite(filePath: string, content: string): void {
	ensureDir(dirname(filePath));
	const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
	writeFileSync(tmpPath, content, CANONICAL_ENCODING);
	renameSync(tmpPath, filePath);
}

// ── Store run metadata ──

/**
 * Initialise the run directory structure and metadata file.
 */
export function initRun(
	cwd: string,
	runId: string,
	metadata: Record<string, unknown> = {},
): void {
	ensureDir(artifactsDir(cwd, runId));
	ensureDir(manifestsDir(cwd, runId));

	const metaPath = runMetaPath(cwd, runId);
	if (!existsSync(metaPath)) {
		const meta = {
			runId,
			createdAt: new Date().toISOString(),
			...metadata,
		};
		atomicWrite(metaPath, canonicalJson(meta) + "\n");
	}
}

// ── Store an artifact ──

/**
 * Store a validated handoff submission as an immutable artifact.
 *
 * Returns the artifact ID on success.
 * Throws if an artifact with the same ID already exists with different content.
 */
export function storeArtifact(
	cwd: string,
	runId: string,
	payload: HandoffSubmission,
	contract = "phenix-flow:handoff",
): { artifactId: string; payloadDigest: string } {
	// Compute digest first
	const payloadDigest = digestJson(payload);
	const artifactId = generateArtifactId();

	const envelope: ArtifactEnvelope<HandoffSubmission> = {
		artifactId,
		contract,
		schemaVersion: 1,
		runId: payload.runId,
		stepId: payload.stepId,
		effectId: payload.effectId,
		attempt: payload.attempt,
		createdAt: new Date().toISOString(),
		payloadDigest,
		payload,
	};

	const path = artifactPath(cwd, runId, artifactId);

	// Check for existing artifact with same ID
	if (existsSync(path)) {
		const existing = readFileSync(path, CANONICAL_ENCODING);
		const existingDigest = sha256(existing.trim());
		const newContent = canonicalJson(envelope);
		const newDigest = sha256(newContent);
		if (existingDigest !== newDigest) {
			throw new Error(
				`Artifact ID collision: ${artifactId} already exists with different content`,
			);
		}
		// Same content — idempotent, return existing ID
		return { artifactId, payloadDigest };
	}

	atomicWrite(path, canonicalJson(envelope) + "\n");
	return { artifactId, payloadDigest };
}

// ── Read an artifact ──

/**
 * Read an artifact envelope from the store, validating its schema on retrieval.
 * Returns null if the artifact does not exist.
 * Throws if the artifact content is corrupted or fails validation.
 */
export function readArtifact(
	cwd: string,
	runId: string,
	artifactId: string,
): ArtifactEnvelope<HandoffSubmission> | null {
	const path = artifactPath(cwd, runId, artifactId);
	if (!existsSync(path)) return null;

	try {
		const content = readFileSync(path, CANONICAL_ENCODING);
		const parsed: ArtifactEnvelope<HandoffSubmission> = JSON.parse(content);

		// Validate payload digest
		const computedDigest = digestJson(parsed.payload);
		if (computedDigest !== parsed.payloadDigest) {
			throw new Error(
				`Artifact ${artifactId} payload digest mismatch: expected ${parsed.payloadDigest}, computed ${computedDigest}`,
			);
		}

		// Re-validate payload schema
		{
			const kindCheck = validateKind(parsed.payload);
			if (kindCheck.ok === false) {
				throw new Error(
					`Artifact ${artifactId} payload kind validation failed: ${(kindCheck as { ok: false; errors: string[] }).errors.join("; ")}`,
				);
			}
		}
		{
			const identityCheck = validateIdentity(parsed.payload);
			if (identityCheck.ok === false) {
				throw new Error(
					`Artifact ${artifactId} payload identity validation failed: ${(identityCheck as { ok: false; errors: string[] }).errors.join("; ")}`,
				);
			}
		}

		return parsed;
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw new Error(`Artifact ${artifactId} is corrupted: invalid JSON`);
		}
		throw err;
	}
}

// ── List artifacts for a run ──

/**
 * List all artifact IDs for a run.
 */
export function listArtifacts(cwd: string, runId: string): string[] {
	const dir = artifactsDir(cwd, runId);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -5)); // remove .json
}

// ── Store a repository manifest ──

/**
 * Store a manifest (content-addressed by its digest).
 * Write is idempotent: if the digest file already exists, no write occurs.
 */
export function storeManifest(
	cwd: string,
	runId: string,
	digest: string,
	manifest: unknown,
): void {
	const path = manifestPath(cwd, runId, digest);
	if (!existsSync(path)) {
		atomicWrite(path, canonicalJson(manifest) + "\n");
	}
}

/**
 * Read a manifest by digest.
 */
export function readManifest(
	cwd: string,
	runId: string,
	digest: string,
): unknown | null {
	const path = manifestPath(cwd, runId, digest);
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, CANONICAL_ENCODING);
		return JSON.parse(content);
	} catch {
		return null;
	}
}

// ── Run metadata management ──

/**
 * Read the run metadata file.
 */
export function readRunMeta(
	cwd: string,
	runId: string,
): Record<string, unknown> | null {
	const path = runMetaPath(cwd, runId);
	if (!existsSync(path)) return null;
	try {
		const content = readFileSync(path, CANONICAL_ENCODING);
		return JSON.parse(content);
	} catch {
		return null;
	}
}
