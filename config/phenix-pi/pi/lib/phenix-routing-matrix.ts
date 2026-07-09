/**
 * phenix-routing-matrix.ts — TypeScript routing matrix helper
 *
 * Encodes the full routing policy from routing-config.yaml in a callable
 * TypeScript API. No YAML parsing needed — agents call the helper with
 * difficulty, secrecy, change kind, and model set, and get back the
 * correct role assignments, denials, and warnings.
 *
 * Usage:
 *   const result = resolveRouting(params);
 *   // result = { allowed, denialReason, roles, warnings, modelRef }
 */

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type Difficulty = "D0" | "D1" | "D2" | "D3";
export type Secrecy = "public" | "private" | "secret";
export type FrontendModel = "auto" | "free" | "mixed" | "opencode-go" | "gpt";
export type TargetState = "scratch" | "dev-wallet" | "main-bound";
export type RoutingRole = "planner" | "critic" | "implementer" | "verifier" | "final_reviewer";

export interface RoutingParams {
	difficulty: Difficulty;
	secrecy: Secrecy;
	changeKind: string;
	/** The frontend model ID (e.g. "free", "opencode-go") — determines which concrete model is used */
	frontendModel: string;
	/** Optional target state for stricter policy checks */
	targetState?: TargetState;
}

export interface RoutedRoles {
	planner: boolean;
	critic: boolean;
	implementer: boolean;
	verifier: boolean;
	final_reviewer: boolean;
}

export interface RoutingResult {
	/** Whether this routing is allowed by policy */
	allowed: boolean;
	/** Human-readable denial reason, present when allowed === false */
	denialReason?: string;
	/** Which roles are active for this routing */
	roles: RoutedRoles;
	/** Non-fatal warnings about the routing */
	warnings: string[];
	/** The resolved concrete model ref (provider/model) */
	modelRef: string;
	/** The frontend model set for subagent resolution */
	frontendModelSet: string;
}

// ──────────────────────────────────────────────
// Routing matrix: difficulty → active roles
// ──────────────────────────────────────────────

const DIFFICULTY_ROLES: Record<Difficulty, RoutingRole[]> = {
	D0: ["planner", "implementer", "verifier"],
	D1: ["planner", "implementer", "verifier"],
	D2: ["planner", "critic", "implementer", "verifier"],
	D3: ["planner", "critic", "implementer", "verifier", "final_reviewer"],
};

// ──────────────────────────────────────────────
// Secrecy policy: which models are allowed
// ──────────────────────────────────────────────

const SECRECY_ALLOWED: Record<Secrecy, boolean> = {
	public: true,
	private: false,
	secret: false,
};

// ──────────────────────────────────────────────
// Change kind guards
// ──────────────────────────────────────────────

/** Change kinds that deny free-tier model routing */
const DENY_FREE_FOR: readonly string[] = [
	"secrets", "sops", "auth", "ssh", "tokens",
	"ci", "github_actions", "deployment", "permissions",
	"security", "repo_architecture", "host_config",
];

/** Change kinds that require a verifier role */
const REQUIRE_VERIFIER_FOR: readonly string[] = [
	"nix", "rust", "workflow", "tend", "stitch", "mcp", "ci", "repo_architecture",
];

/** Change kinds that require a strong planner */
const REQUIRE_STRONG_PLANNER_FOR: readonly string[] = [
	"workflow", "tend", "stitch", "mcp", "repo_architecture", "secrets", "permissions",
];

// ──────────────────────────────────────────────
// Target state policy
// ──────────────────────────────────────────────

interface TargetStatePolicy {
	allowIncomplete: boolean;
	verifierRequired: boolean;
	strictChecks: boolean;
	requireCleanState?: boolean;
	denyD2D3DirectMainCommit?: boolean;
}

const TARGET_STATE_POLICIES: Record<TargetState, TargetStatePolicy> = {
	scratch: { allowIncomplete: true, verifierRequired: false, strictChecks: false },
	"dev-wallet": { allowIncomplete: true, verifierRequired: true, strictChecks: false },
	"main-bound": {
		allowIncomplete: false,
		verifierRequired: true,
		strictChecks: true,
		requireCleanState: true,
		denyD2D3DirectMainCommit: true,
	},
};

// ──────────────────────────────────────────────
// Model slot resolution
// ──────────────────────────────────────────────

/**
 * Maps frontend model ID → concrete model ref (provider/model).
 * Same as phenix-router.ts but in a callable form.
 */
const FRONTEND_MODEL_MAP: Record<string, { provider: string; model: string }> = {
	auto: { provider: "opencode", model: "deepseek-v4-flash-free" },
	free: { provider: "opencode", model: "deepseek-v4-flash-free" },
	mixed: { provider: "opencode", model: "deepseek-v4-flash-free" },
	"opencode-go": { provider: "opencode", model: "deepseek-v4-flash" },
	gpt: { provider: "openai", model: "gpt-5.5" },
};

/** Frontend model set for subagent executor resolution */
const FRONTEND_MODEL_SETS: Record<string, string> = {
	auto: "phenix/free",
	free: "phenix/free",
	mixed: "phenix/mixed",
	"opencode-go": "phenix/opencode-go",
	gpt: "phenix/gpt",
};

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function normalizeChangeKind(kind: string): string {
	return kind.toLowerCase().replace(/[^a-z0-9_]/g, "");
}

function matchList(value: string, list: readonly string[]): boolean {
	const normalized = normalizeChangeKind(value);
	return list.some((item) => normalized === item || normalized.includes(item));
}

// ──────────────────────────────────────────────
// Main resolver
// ──────────────────────────────────────────────

/**
 * Resolve the routing matrix for the given parameters.
 * Returns the active roles, denials, warnings, and concrete model ref.
 */
export function resolveRouting(params: RoutingParams): RoutingResult {
	const { difficulty, secrecy, changeKind, frontendModel, targetState } = params;
	const warnings: string[] = [];
	const frontendSet = FRONTEND_MODEL_SETS[frontendModel] ?? "phenix/free";
	const modelRefObj = FRONTEND_MODEL_MAP[frontendModel] ?? FRONTEND_MODEL_MAP.free;
	const modelRef = `${modelRefObj.provider}/${modelRefObj.model}`;
	const isFreeModel = frontendModel === "auto" || frontendModel === "free";

	// ── Secrecy check ──
	if (!SECRECY_ALLOWED[secrecy]) {
		return {
			allowed: false,
			denialReason: `Free model routing denied for ${secrecy} work. Change kind: ${changeKind}`,
			roles: { planner: false, critic: false, implementer: false, verifier: false, final_reviewer: false },
			warnings: ["Routing denied by secrecy policy"],
			modelRef,
			frontendModelSet: frontendSet,
		};
	}

	// ── Free-model denial check ──
	if (isFreeModel && matchList(changeKind, DENY_FREE_FOR)) {
		return {
			allowed: false,
			denialReason: `Free model routing denied for change kind "${changeKind}". Use "phenix/opencode-go" or "phenix/gpt" frontend model instead.`,
			roles: { planner: false, critic: false, implementer: false, verifier: false, final_reviewer: false },
			warnings: ["Routing denied by change kind guard"],
			modelRef,
			frontendModelSet: frontendSet,
		};
	}

	// ── Difficulty → roles ──
	const activeRoles = DIFFICULTY_ROLES[difficulty] ?? DIFFICULTY_ROLES.D1;
	const roles: RoutedRoles = {
		planner: activeRoles.includes("planner"),
		critic: activeRoles.includes("critic"),
		implementer: activeRoles.includes("implementer"),
		verifier: activeRoles.includes("verifier"),
		final_reviewer: activeRoles.includes("final_reviewer"),
	};

	// ── Verifier requirement guard ──
	if (!roles.verifier && matchList(changeKind, REQUIRE_VERIFIER_FOR)) {
		warnings.push(
			`Change kind "${changeKind}" normally requires a verifier, but difficulty ${difficulty} does not include one. Consider D2+ routing.`,
		);
	}

	// ── Strong planner requirement guard ──
	if (matchList(changeKind, REQUIRE_STRONG_PLANNER_FOR)) {
		warnings.push(
			`Change kind "${changeKind}" requires strong planning. If using "phenix/free", the free model may not be sufficient.`,
		);
	}

	// ── Target state checks ──
	if (targetState) {
		const policy = TARGET_STATE_POLICIES[targetState];
		if (policy.verifierRequired && !roles.verifier) {
			warnings.push(
				`Target state "${targetState}" requires a verifier, but difficulty ${difficulty} does not include one.`,
			);
		}
		if (policy.strictChecks && !roles.verifier) {
			warnings.push(
				`Target state "${targetState}" has strict checks enabled. A verifier role is strongly recommended.`,
			);
		}
		if (policy.denyD2D3DirectMainCommit && (difficulty === "D2" || difficulty === "D3")) {
			warnings.push(
				`D2/D3 work cannot be committed directly to main in "${targetState}" target state. Use dev-wallet or wallet flow.`,
			);
		}
	}

	return { allowed: true, roles, warnings, modelRef, frontendModelSet: frontendSet };
}

/**
 * Classify a prompt into a difficulty level.
 * Mirrors the YAML difficulty_classifier.
 */
export function classifyDifficulty(prompt: string): Difficulty {
	const lower = prompt.toLowerCase();
	if (
		lower.includes("d0") ||
		/\b(typo|format|rename|trivial|obvious|mechanical)\b/i.test(lower)
	)
		return "D0";
	if (
		lower.includes("d3") ||
		/\b(high.risk|ambiguous|security|secret|main.bound|release|cross.repo)\b/i.test(lower)
	)
		return "D3";
	if (
		lower.includes("d2") ||
		/\b(architect|multi.file|cross.module|complex|refactor|restructur|redesign)\b/i.test(lower)
	)
		return "D2";
	return "D1";
}

/**
 * Classify a prompt into a secrecy level.
 */
export function classifySecrecy(prompt: string): Secrecy {
	const lower = prompt.toLowerCase();
	if (lower.includes("secret") || lower.includes("sops") || lower.includes("token"))
		return "secret";
	if (lower.includes("private") || lower.includes("personal") || lower.includes("internal"))
		return "private";
	return "public";
}

/**
 * Classify a prompt into a change kind.
 */
export function classifyChangeKind(prompt: string): string {
	const lower = prompt.toLowerCase();
	const keywords: Array<[RegExp, string]> = [
		[/\b(nix|flake|derivation)\b/, "nix"],
		[/\b(rust|cargo|crate)\b/, "rust"],
		[/\b(workflow|flow|pipeline)\b/, "workflow"],
		[/\b(tend|stitch)\b/, "tend"],
		[/\b(mcp)\b/, "mcp"],
		[/\b(ci|github.action)\b/, "ci"],
		[/\b(doc|readme|markdown|md)\b/, "docs"],
		[/\b(config|configur)\b/, "config"],
		[/\b(secur|secret|sops|auth|token|ssh)\b/, "secrets"],
		[/\b(permission|access|role)\b/, "permissions"],
		[/\b(deploy|release|publish)\b/, "deployment"],
		[/\b(test|spec|assert)\b/, "tests"],
		[/\b(refactor|restructur|redesign)\b/, "refactor"],
		[/\b(architect|module|boundary)\b/, "repo_architecture"],
	];
	for (const [pattern, kind] of keywords) {
		if (pattern.test(lower)) return kind;
	}
	return "unknown";
}

/**
 * Classify a prompt into a target state.
 */
export function classifyTargetState(prompt: string): TargetState {
	const lower = prompt.toLowerCase();
	if (lower.includes("main-bound") || lower.includes("main_bound") || lower.includes("main branch"))
		return "main-bound";
	if (lower.includes("dev-wallet") || lower.includes("dev_wallet") || lower.includes("wallet"))
		return "dev-wallet";
	return "scratch";
}

/**
 * One-shot: classify a prompt and resolve the full routing in a single call.
 * Agents call this with just the prompt and frontend model.
 */
export function classifyAndRoute(
	prompt: string,
	frontendModel: string,
): RoutingResult {
	const difficulty = classifyDifficulty(prompt);
	const secrecy = classifySecrecy(prompt);
	const changeKind = classifyChangeKind(prompt);
	const targetState = classifyTargetState(prompt);
	return resolveRouting({ difficulty, secrecy, changeKind, frontendModel, targetState });
}

// ──────────────────────────────────────────────
// Validation profiles for verification
// ──────────────────────────────────────────────

export interface ValidationProfile {
	commands: string[];
}

export const VALIDATION_PROFILES: Record<string, ValidationProfile> = {
	fast: { commands: ["nix flake check --no-build"] },
	normal: { commands: ["nix flake check", "cargo test --all"] },
	strict: {
		commands: [
			"nix flake check",
			"cargo test --all",
			"cargo clippy --all-targets --all-features -- -D warnings",
			"cargo fmt --all --check",
		],
	},
};

// ──────────────────────────────────────────────
// Planner contract rules
// ──────────────────────────────────────────────

export const IMPLEMENTER_RULES: readonly string[] = [
	"Do not expand scope beyond the accepted plan.",
	"Stop on contract violation — do not continue if the plan no longer matches intent.",
	"Stop if private/secret data reaches a free model.",
	"Escalate after two identical test failures.",
	"Escalate if unrelated modules become necessary.",
];

export const VERIFIER_RULES: readonly string[] = [
	"Verify contract satisfaction.",
	"Verify external-plan adjustments are minimal.",
	"Verify routing policy was followed.",
	"Verify architecture constraints are preserved.",
	"Verify tests match difficulty.",
	"Require strict checks for main-bound work.",
];
