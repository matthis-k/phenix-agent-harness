import type { WorkflowOutputSchemaId } from "./workflow-types.ts";

// ── Fixed output schemas ────────────────────────────────────────────────────

/**
 * Scout handoff schema.
 */
export const SCOUT_HANDOFF_SCHEMA: Record<string, unknown> = {
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
};

/**
 * Planner handoff schema.
 */
export const PLANNER_HANDOFF_SCHEMA: Record<string, unknown> = {
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
};

/**
 * Architecture handoff schema.
 */
export const ARCHITECTURE_HANDOFF_SCHEMA: Record<string, unknown> = {
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
};

/**
 * Implementation handoff schema.
 */
export const IMPLEMENTATION_HANDOFF_SCHEMA: Record<string, unknown> = {
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
};

/**
 * Test handoff schema.
 */
export const TEST_HANDOFF_SCHEMA: Record<string, unknown> = {
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
};

/**
 * Finalizer handoff schema.
 */
export const FINALIZER_HANDOFF_SCHEMA: Record<string, unknown> = {
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
};

/**
 * Critic handoff schema.
 */
export const CRITIC_HANDOFF_SCHEMA: Record<string, unknown> = {
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
};

/**
 * Base handoff schema.
 */
export const BASE_HANDOFF_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "result"],
  properties: {
    summary: { type: "string", minLength: 1 },
    result: {},
  },
};

// ── Schema lookup map ───────────────────────────────────────────────────────

export const OUTPUT_SCHEMAS: Readonly<
  Record<WorkflowOutputSchemaId, Record<string, unknown>>
> = {
  "scout-handoff": SCOUT_HANDOFF_SCHEMA,
  "planner-handoff": PLANNER_HANDOFF_SCHEMA,
  "architecture-handoff": ARCHITECTURE_HANDOFF_SCHEMA,
  "implementation-handoff": IMPLEMENTATION_HANDOFF_SCHEMA,
  "test-handoff": TEST_HANDOFF_SCHEMA,
  "finalizer-handoff": FINALIZER_HANDOFF_SCHEMA,
  "critic-handoff": CRITIC_HANDOFF_SCHEMA,
  "base-handoff": BASE_HANDOFF_SCHEMA,
};

export function getOutputSchema(id: WorkflowOutputSchemaId): Record<string, unknown> {
  const schema = OUTPUT_SCHEMAS[id];
  if (!schema) {
    throw new Error(`Unknown output schema ID: ${id}`);
  }
  return schema;
}
