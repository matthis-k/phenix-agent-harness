import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";

export type DynamicValueBinding =
  | {
      readonly source: "input";
      readonly path?: readonly string[];
    }
  | {
      readonly source: "node";
      readonly nodeId: string;
      readonly path?: readonly string[];
    }
  | {
      readonly source: "literal";
      readonly value: unknown;
    }
  | {
      readonly source: "object";
      readonly fields: Readonly<Record<string, DynamicValueBinding>>;
    }
  | {
      readonly source: "array";
      readonly items: readonly DynamicValueBinding[];
    };

export interface DynamicInvokeNodeProposal {
  readonly kind: "invoke";
  readonly id: string;
  readonly title?: string;
  readonly definitionId: string;
  /** Required when definitionId is session.stock; omitted for fixed-output definitions. */
  readonly outputSchema?: string;
  readonly input: DynamicValueBinding;
  readonly retry?: {
    readonly maxRetries: number;
  };
}

export interface DynamicJoinNodeProposal {
  readonly kind: "join";
  readonly id: string;
  readonly title?: string;
  readonly policy: "all" | "all-success" | "first-success" | "quorum";
  readonly quorum?: number;
}

export interface DynamicReturnNodeProposal {
  readonly kind: "return";
  readonly id: string;
  readonly title?: string;
  readonly output: DynamicValueBinding;
}

export type DynamicWorkflowNodeProposal =
  | DynamicInvokeNodeProposal
  | DynamicJoinNodeProposal
  | DynamicReturnNodeProposal;

export interface DynamicWorkflowEdgeProposal {
  readonly from: string;
  readonly to: string;
  readonly on?: "success" | "failure" | "cancelled" | "any";
}

export interface DynamicWorkflowProposal {
  readonly title: string;
  readonly description: string;
  readonly inputSchema: string;
  readonly outputSchema: string;
  readonly entry: string;
  readonly nodes: readonly DynamicWorkflowNodeProposal[];
  readonly edges: readonly DynamicWorkflowEdgeProposal[];
  readonly limits: {
    readonly timeoutMs: number;
    readonly maxNodeRuns: number;
    readonly maxParallelism: number;
  };
}

export interface DynamicWorkflowCandidate {
  readonly definitionId: string;
  readonly kind: "agent" | "workflow" | "session";
  readonly title: string;
  readonly description: string;
  readonly inputSchema: string;
  readonly outputSchema: string;
}

export interface DynamicWorkflowCompositionRequest {
  readonly objective: string;
  readonly context?: unknown;
  readonly workflowInputSchema: string;
  readonly candidates: readonly DynamicWorkflowCandidate[];
}

const IdentifierType = Type.String({
  minLength: 1,
  maxLength: 96,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

const PathType = Type.Optional(
  Type.Array(Type.String({ minLength: 1, maxLength: 96 }), { maxItems: 16 }),
);

const DynamicValueBindingType = Type.Union([
  Type.Object(
    {
      source: Type.Literal("input"),
      path: PathType,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("node"),
      nodeId: IdentifierType,
      path: PathType,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("literal"),
      value: Type.Unknown(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("object"),
      fields: Type.Record(Type.String({ minLength: 1, maxLength: 96 }), Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      source: Type.Literal("array"),
      items: Type.Array(Type.Unknown(), { maxItems: 64 }),
    },
    { additionalProperties: false },
  ),
]);

const DynamicInvokeNodeType = Type.Object(
  {
    kind: Type.Literal("invoke"),
    id: IdentifierType,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    definitionId: Type.String({ minLength: 1, maxLength: 160 }),
    outputSchema: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    input: DynamicValueBindingType,
    retry: Type.Optional(
      Type.Object(
        {
          maxRetries: Type.Integer({ minimum: 1, maximum: 3 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const DynamicJoinNodeType = Type.Object(
  {
    kind: Type.Literal("join"),
    id: IdentifierType,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    policy: Type.Enum(["all", "all-success", "first-success", "quorum"]),
    quorum: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  },
  { additionalProperties: false },
);

const DynamicReturnNodeType = Type.Object(
  {
    kind: Type.Literal("return"),
    id: IdentifierType,
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
    output: DynamicValueBindingType,
  },
  { additionalProperties: false },
);

export const DynamicWorkflowCompositionRequestSchema =
  defineSchema<DynamicWorkflowCompositionRequest>(
    "request.dynamic-workflow-composition",
    Type.Object(
      {
        objective: Type.String({ minLength: 1, maxLength: 20_000 }),
        context: Type.Optional(Type.Unknown()),
        workflowInputSchema: Type.String({ minLength: 1, maxLength: 160 }),
        candidates: Type.Array(
          Type.Object(
            {
              definitionId: Type.String({ minLength: 1, maxLength: 160 }),
              kind: Type.Enum(["agent", "workflow", "session"]),
              title: Type.String({ minLength: 1, maxLength: 160 }),
              description: Type.String({ minLength: 1, maxLength: 1000 }),
              inputSchema: Type.String({ minLength: 1, maxLength: 160 }),
              outputSchema: Type.String({ minLength: 1, maxLength: 160 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 32 },
        ),
      },
      { additionalProperties: false },
    ),
  );

export const DynamicWorkflowProposalSchema = defineSchema<DynamicWorkflowProposal>(
  "request.dynamic-workflow-proposal",
  Type.Object(
    {
      title: Type.String({ minLength: 1, maxLength: 160 }),
      description: Type.String({ minLength: 1, maxLength: 1000 }),
      inputSchema: Type.String({ minLength: 1, maxLength: 160 }),
      outputSchema: Type.String({ minLength: 1, maxLength: 160 }),
      entry: IdentifierType,
      nodes: Type.Array(
        Type.Union([DynamicInvokeNodeType, DynamicJoinNodeType, DynamicReturnNodeType]),
        { minItems: 2, maxItems: 32 },
      ),
      edges: Type.Array(
        Type.Object(
          {
            from: IdentifierType,
            to: IdentifierType,
            on: Type.Optional(Type.Enum(["success", "failure", "cancelled", "any"])),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, maxItems: 64 },
      ),
      limits: Type.Object(
        {
          timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
          maxNodeRuns: Type.Integer({ minimum: 2, maximum: 128 }),
          maxParallelism: Type.Integer({ minimum: 1, maximum: 8 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
);
