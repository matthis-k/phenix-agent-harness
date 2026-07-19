/**
 * phenix-contracts — default bundled contract definitions
 *
 * Each contract definition has:
 * - A unique ContractDefinitionId
 * - A human-readable description
 * - A fixed JSON Schema for output validation
 */

import type { ContractDefinition } from "@matthis-k/phenix-contracts/definitions.ts";
import { contractDefinitionId } from "@matthis-k/phenix-kernel/ids.ts";

// ── Scout handoff ──────────────────────────────────────────────────────────

export const SCOUT_HANDOFF: ContractDefinition = {
  id: contractDefinitionId("scout-handoff"),
  description: "Scout agent produces discovery evidence and unknowns.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "evidence", "unknowns"],
    properties: {
      summary: { type: "string", minLength: 1 },
      evidence: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "evidence"],
          properties: {
            path: { type: "string" },
            claim: { type: "string", minLength: 1 },
            evidence: { type: "string", minLength: 1 },
          },
        },
      },
      unknowns: { type: "array", items: { type: "string", minLength: 1 } },
    },
  },
};

// ── Planner handoff ────────────────────────────────────────────────────────

export const PLANNER_HANDOFF: ContractDefinition = {
  id: contractDefinitionId("planner-handoff"),
  description: "Planner produces structured task steps, affected areas, and risks.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "steps", "crossCuttingDesignRequired", "risks"],
    properties: {
      summary: { type: "string", minLength: 1 },
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "description", "affectedAreas"],
          properties: {
            id: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            affectedAreas: { type: "array", items: { type: "string" } },
          },
        },
      },
      crossCuttingDesignRequired: { type: "boolean" },
      risks: { type: "array", items: { type: "string", minLength: 1 } },
    },
  },
};

// ── Architecture handoff ───────────────────────────────────────────────────

export const ARCHITECTURE_HANDOFF: ContractDefinition = {
  id: contractDefinitionId("architecture-handoff"),
  description: "Architect produces interface, ownership, lifecycle, and risk design.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "interfaces", "ownership", "lifecycle", "risks"],
    properties: {
      summary: { type: "string", minLength: 1 },
      interfaces: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "description", "consumers", "providers"],
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string" },
            consumers: { type: "array", items: { type: "string" } },
            providers: { type: "array", items: { type: "string" } },
          },
        },
      },
      ownership: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["component", "owner"],
          properties: {
            component: { type: "string", minLength: 1 },
            owner: { type: "string", minLength: 1 },
            path: { type: "string" },
          },
        },
      },
      lifecycle: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["phase", "description"],
          properties: {
            phase: { type: "string", minLength: 1 },
            description: { type: "string" },
          },
        },
      },
      risks: { type: "array", items: { type: "string", minLength: 1 } },
    },
  },
};

// ── Implementation handoff ─────────────────────────────────────────────────

export const IMPLEMENTATION_HANDOFF: ContractDefinition = {
  id: contractDefinitionId("implementation-handoff"),
  description: "Implementer produces a change summary with changed files and test results.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "changedFiles",
      "behaviorChanged",
      "testsAdded",
      "testsRun",
      "requiresDedicatedTesting",
    ],
    properties: {
      summary: { type: "string", minLength: 1 },
      changedFiles: { type: "array", items: { type: "string" } },
      behaviorChanged: { type: "boolean" },
      testsAdded: { type: "array", items: { type: "string" } },
      testsRun: { type: "array", items: { type: "string" } },
      requiresDedicatedTesting: { type: "boolean" },
    },
  },
};

// ── Test handoff ───────────────────────────────────────────────────────────

export const TEST_HANDOFF: ContractDefinition = {
  id: contractDefinitionId("test-handoff"),
  description: "Tester produces identified tests, run results, and coverage assessment.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "testsIdentified", "testsRun", "results", "coverageSatisfactory"],
    properties: {
      summary: { type: "string", minLength: 1 },
      testsIdentified: { type: "array", items: { type: "string" } },
      testsRun: { type: "array", items: { type: "string" } },
      results: {
        type: "object",
        additionalProperties: false,
        required: ["passed", "failed", "skipped"],
        properties: {
          passed: { type: "integer", minimum: 0 },
          failed: { type: "integer", minimum: 0 },
          skipped: { type: "integer", minimum: 0 },
        },
      },
      coverageSatisfactory: { type: "boolean" },
      failures: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["test", "error"],
          properties: {
            test: { type: "string" },
            error: { type: "string" },
          },
        },
      },
    },
  },
};

// ── Finalizer handoff ──────────────────────────────────────────────────────

export const FINALIZER_HANDOFF: ContractDefinition = {
  id: contractDefinitionId("finalizer-handoff"),
  description: "Finalizer produces deliverables, verification results, and residual risks.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "deliverables", "verificationResults", "residualRisks"],
    properties: {
      summary: { type: "string", minLength: 1 },
      deliverables: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["description", "path", "status"],
          properties: {
            description: { type: "string" },
            path: { type: "string" },
            status: { enum: ["completed", "incomplete"] },
          },
        },
      },
      verificationResults: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["check", "result"],
          properties: {
            check: { type: "string" },
            result: { enum: ["passed", "failed", "skipped"] },
            detail: { type: "string" },
          },
        },
      },
      residualRisks: { type: "array", items: { type: "string", minLength: 1 } },
    },
  },
};

// ── Critic handoff ─────────────────────────────────────────────────────────

export const CRITIC_HANDOFF: ContractDefinition = {
  id: contractDefinitionId("critic-handoff"),
  description: "Critic produces an approve/reject verdict with findings and missing requirements.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "findings", "missingRequirements"],
    properties: {
      verdict: { enum: ["approve", "reject"] },
      summary: { type: "string", minLength: 1 },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "description", "evidence"],
          properties: {
            severity: { enum: ["minor", "major", "critical"] },
            description: { type: "string", minLength: 1 },
            evidence: { type: "string", minLength: 1 },
            requirement: { type: "string" },
          },
        },
      },
      missingRequirements: { type: "array", items: { type: "string", minLength: 1 } },
    },
  },
};

// ── Base handoff ───────────────────────────────────────────────────────────

export const BASE_HANDOFF: ContractDefinition = {
  id: contractDefinitionId("base-handoff"),
  description: "Base agent produces a summary and result without specialized output schema.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "result"],
    properties: {
      summary: { type: "string", minLength: 1 },
      result: {},
    },
  },
};

// ── Default contracts collection ───────────────────────────────────────────

export const defaultContracts: readonly ContractDefinition[] = [
  SCOUT_HANDOFF,
  PLANNER_HANDOFF,
  ARCHITECTURE_HANDOFF,
  IMPLEMENTATION_HANDOFF,
  TEST_HANDOFF,
  FINALIZER_HANDOFF,
  CRITIC_HANDOFF,
  BASE_HANDOFF,
];
