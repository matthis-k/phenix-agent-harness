/**
 * handoff/projections.ts — Pure context projection functions.
 *
 * Each function selects only the content a specific role needs.
 * No generic "collect all outputs" function exists.
 * Prefer references (artifact IDs) over duplicating content.
 */

import type {
	ScoutResult,
	PlanResult,
	WorkerResult,
	AcceptedArtifact,
	VerificationReport,
	RepositoryManifest,
} from "./schemas.js";

// ── Type-safe artifact accessors ──

function asScout(artifact: AcceptedArtifact): ScoutResult | null {
	if (artifact.submission.kind === "scout-result") {
		return artifact.submission;
	}
	return null;
}

function asPlan(artifact: AcceptedArtifact): PlanResult | null {
	if (artifact.submission.kind === "plan") {
		return artifact.submission;
	}
	return null;
}

function asWorker(artifact: AcceptedArtifact): WorkerResult | null {
	if (artifact.submission.kind === "worker-result") {
		return artifact.submission;
	}
	return null;
}

// ── Role-specific context types ──

export interface PlannerContext {
	userTask: string;
	scout?: ScoutResult;
}

export interface WorkerContext {
	userTask: string;
	plan: PlanResult;
	scoutSummary?: Pick<
		ScoutResult,
		"relevantFiles" | "editPoints" | "constraints" | "risks"
	>;
}

export interface VerifierContext {
	userTask: string;
	plan: PlanResult;
	worker: WorkerResult;
	repositoryManifest: RepositoryManifest;
	requiredChecks: string[];
}

export interface RepairContext {
	userTask: string;
	plan: PlanResult;
	repositoryManifest: RepositoryManifest;
	blockingFindings: VerificationReport["findings"];
}

// ── Projection functions ──

/**
 * Build context for the planner role.
 * Includes the user task and, optionally, scout results.
 */
export function projectForPlanner(
	userTask: string,
	artifacts: AcceptedArtifact[],
): PlannerContext {
	const ctx: PlannerContext = { userTask };

	for (const a of artifacts) {
		const scout = asScout(a);
		if (scout) {
			ctx.scout = scout;
			break; // only first scout result
		}
	}

	return ctx;
}

/**
 * Build context for the worker role.
 * Includes the user task, plan, and a concise scout summary.
 */
export function projectForWorker(
	userTask: string,
	artifacts: AcceptedArtifact[],
): WorkerContext | null {
	let plan: PlanResult | null = null;
	let scout: ScoutResult | null = null;

	for (const a of artifacts) {
		if (!plan) plan = asPlan(a);
		if (!scout) scout = asScout(a);
	}

	if (!plan) return null;

	const ctx: WorkerContext = {
		userTask,
		plan,
	};

	if (scout) {
		ctx.scoutSummary = {
			relevantFiles: scout.relevantFiles,
			editPoints: scout.editPoints,
			constraints: scout.constraints,
			risks: scout.risks,
		};
	}

	return ctx;
}

/**
 * Build context for the verifier role.
 * Includes the task, plan, worker output, manifest, and required criteria IDs.
 */
export function projectForVerifier(
	userTask: string,
	artifacts: AcceptedArtifact[],
	repositoryManifest: RepositoryManifest,
): VerifierContext | null {
	let plan: PlanResult | null = null;
	let worker: WorkerResult | null = null;

	for (const a of artifacts) {
		if (!plan) plan = asPlan(a);
		if (!worker) worker = asWorker(a);
	}

	if (!plan || !worker) return null;

	const requiredChecks = plan.acceptanceCriteria.map((ac) => ac.id);

	return {
		userTask,
		plan,
		worker,
		repositoryManifest,
		requiredChecks,
	};
}

/**
 * Build context for the repair role.
 * Includes the task, plan, manifest, and only blocking findings.
 */
export function projectForRepair(
	userTask: string,
	artifacts: AcceptedArtifact[],
	repositoryManifest: RepositoryManifest,
	blockingFindings: VerificationReport["findings"],
): RepairContext | null {
	let plan: PlanResult | null = null;

	for (const a of artifacts) {
		if (!plan) plan = asPlan(a);
	}

	if (!plan) return null;

	return {
		userTask,
		plan,
		repositoryManifest,
		blockingFindings,
	};
}
