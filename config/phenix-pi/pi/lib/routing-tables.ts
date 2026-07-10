/**
 * routing-tables.ts — Routing table data for the Phenix routing matrix.
 *
 * Pure data: maps variant × difficulty → per-role model/thinking assignments.
 * Extracted from phenix-routing-matrix.ts to separate data from logic.
 */

import type {
	Variant,
	Difficulty,
	Role,
	RoleRoute,
} from "./phenix-routing-matrix";

// ══════════════════════════════════════════════
// MODEL LISTS
// ══════════════════════════════════════════════

export const OPENCODE_GO_MODELS: string[] = [
	"opencode-go/glm-5.2",
	"opencode-go/glm-5.1",
	"opencode-go/kimi-k2.7-code",
	"opencode-go/kimi-k2.6",
	"opencode-go/mimo-v2.5",
	"opencode-go/mimo-v2.5-pro",
	"opencode-go/minimax-m3",
	"opencode-go/minimax-m2.7",
	"opencode-go/minimax-m2.5",
	"opencode-go/qwen3.7-max",
	"opencode-go/qwen3.7-plus",
	"opencode-go/qwen3.6-plus",
	"opencode-go/deepseek-v4-pro",
	"opencode-go/deepseek-v4-flash",
];

export const GPT_CAPABILITY_PREFERENCES: Record<string, string[]> = {
	fast: ["openai/gpt-5.5-instant", "openai/gpt-5.5", "openai/gpt-5.5-thinking"],
	thinking: ["openai/gpt-5.5-thinking", "openai/gpt-5.5"],
	pro: ["openai/gpt-5.5-pro", "openai/gpt-5.5-thinking", "openai/gpt-5.5"],
};

export const FREE_DENIED_CHANGE_KINDS: readonly string[] = [
	"security",
	"auth",
	"ci",
	"deployment",
];

// ══════════════════════════════════════════════
// VARIANT ROLE TABLES
// ══════════════════════════════════════════════

const OPENCODE_GO_ROLES: Record<
	Difficulty,
	Partial<Record<Role, RoleRoute>>
> = {
	D0: {
		implementer: {
			enabled: true,
			model: "opencode-go/deepseek-v4-flash",
			thinking: "low",
		},
	},
	D1: {
		scout: {
			enabled: true,
			model: "opencode-go/deepseek-v4-flash",
			thinking: "low",
		},
		planner: {
			enabled: true,
			model: "opencode-go/qwen3.7-plus",
			thinking: "medium",
		},
		implementer: {
			enabled: true,
			model: "opencode-go/kimi-k2.7-code",
			thinking: "low",
		},
		verifier: {
			enabled: true,
			model: "opencode-go/deepseek-v4-pro",
			thinking: "medium",
		},
	},
	D2: {
		scout: {
			enabled: true,
			model: "opencode-go/deepseek-v4-flash",
			thinking: "medium",
		},
		planner: { enabled: true, model: "opencode-go/glm-5.1", thinking: "high" },
		critic: {
			enabled: true,
			model: "opencode-go/deepseek-v4-pro",
			thinking: "medium",
		},
		implementer: {
			enabled: true,
			model: "opencode-go/kimi-k2.7-code",
			thinking: "medium",
		},
		verifier: { enabled: true, model: "opencode-go/glm-5.1", thinking: "high" },
	},
	D3: {
		scout: {
			enabled: true,
			model: "opencode-go/deepseek-v4-pro",
			thinking: "high",
		},
		planner: { enabled: true, model: "opencode-go/glm-5.2", thinking: "xhigh" },
		critic: {
			enabled: true,
			model: "opencode-go/qwen3.7-max",
			thinking: "high",
		},
		implementer: {
			enabled: true,
			model: "opencode-go/kimi-k2.7-code",
			thinking: "high",
		},
		verifier: {
			enabled: true,
			model: "opencode-go/glm-5.2",
			thinking: "xhigh",
		},
		final_reviewer: {
			enabled: true,
			model: "opencode-go/glm-5.2",
			thinking: "xhigh",
		},
	},
};

const FREE_ROLES: Record<Difficulty, Partial<Record<Role, RoleRoute>>> = {
	D0: {
		implementer: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "low",
		},
	},
	D1: {
		scout: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "low",
		},
		planner: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "medium",
		},
		implementer: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "low",
		},
		verifier: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "medium",
		},
	},
	D2: {
		scout: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "medium",
		},
		planner: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "high",
		},
		implementer: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "medium",
		},
		verifier: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "high",
		},
	},
	D3: {
		scout: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "high",
		},
		planner: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "xhigh",
		},
		implementer: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "high",
		},
		verifier: {
			enabled: true,
			model: "opencode/deepseek-v4-flash-free",
			thinking: "xhigh",
		},
	},
};

const GPT_ROLES: Record<Difficulty, Partial<Record<Role, RoleRoute>>> = {
	D0: {
		implementer: { enabled: true, model: "fast", thinking: "low" },
	},
	D1: {
		scout: { enabled: true, model: "fast", thinking: "low" },
		planner: { enabled: true, model: "thinking", thinking: "medium" },
		implementer: { enabled: true, model: "fast", thinking: "low" },
		verifier: { enabled: true, model: "thinking", thinking: "medium" },
	},
	D2: {
		scout: { enabled: true, model: "fast", thinking: "medium" },
		planner: { enabled: true, model: "thinking", thinking: "high" },
		implementer: { enabled: true, model: "fast", thinking: "medium" },
		verifier: { enabled: true, model: "thinking", thinking: "high" },
	},
	D3: {
		scout: { enabled: true, model: "thinking", thinking: "high" },
		planner: { enabled: true, model: "thinking", thinking: "high" },
		implementer: { enabled: true, model: "thinking", thinking: "high" },
		verifier: { enabled: true, model: "thinking", thinking: "high" },
		final_reviewer: { enabled: true, model: "pro", thinking: "xhigh" },
	},
};

const MIXED_ROLES: Record<Difficulty, Partial<Record<Role, RoleRoute>>> = {
	D0: {
		implementer: {
			enabled: true,
			model: "opencode-go/deepseek-v4-flash",
			thinking: "low",
		},
	},
	D1: {
		scout: {
			enabled: true,
			model: "opencode-go/deepseek-v4-flash",
			thinking: "low",
		},
		planner: {
			enabled: true,
			model: "opencode-go/qwen3.7-plus",
			thinking: "medium",
		},
		implementer: {
			enabled: true,
			model: "opencode-go/kimi-k2.7-code",
			thinking: "low",
		},
		verifier: {
			enabled: true,
			model: "opencode-go/deepseek-v4-pro",
			thinking: "medium",
		},
	},
	D2: {
		scout: {
			enabled: true,
			model: "opencode-go/deepseek-v4-flash",
			thinking: "medium",
		},
		planner: { enabled: true, model: "gpt/thinking", thinking: "high" },
		implementer: {
			enabled: true,
			model: "opencode-go/kimi-k2.7-code",
			thinking: "medium",
		},
		verifier: { enabled: true, model: "gpt/thinking", thinking: "high" },
	},
	D3: {
		scout: {
			enabled: true,
			model: "opencode-go/deepseek-v4-flash",
			thinking: "medium",
		},
		planner: { enabled: true, model: "gpt/thinking", thinking: "high" },
		implementer: {
			enabled: true,
			model: "opencode-go/kimi-k2.7-code",
			thinking: "high",
		},
		verifier: { enabled: true, model: "gpt/thinking", thinking: "high" },
		final_reviewer: { enabled: true, model: "gpt/pro", thinking: "xhigh" },
	},
};

// ══════════════════════════════════════════════
// EXPORT: variant → roles lookup
// ══════════════════════════════════════════════

export const VARIANT_ROLES: Record<
	Variant,
	Record<Difficulty, Partial<Record<Role, RoleRoute>>>
> = {
	"opencode-go": OPENCODE_GO_ROLES,
	free: FREE_ROLES,
	gpt: GPT_ROLES,
	mixed: MIXED_ROLES,
};
