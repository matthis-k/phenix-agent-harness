import path from "node:path";

import type {
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  authorizeContract,
  parseContractId,
} from "./phenix-subagents/contract.ts";
import {
  decodeContractIdentity,
} from "./phenix-subagents/contract-identity.ts";
import {
  FileContractStore,
  ContractStoreError,
} from "./phenix-subagents/contract-store.ts";
import {
  validateContract,
} from "./phenix-subagents/contracts.ts";

const GetContractParams = Type.Object(
  {
    id: Type.String({
      minLength: 1,
    }),
  },
  {
    additionalProperties: false,
  },
);

const SubmitContractParams = Type.Object(
  {
    id: Type.String({
      minLength: 1,
    }),
    value: Type.Unknown({
      description:
        "Complete JSON value required by the delegated contract.",
    }),
  },
  {
    additionalProperties: false,
  },
);

import {
  findProjectRoot,
} from "./phenix-subagents/handle-store.ts";

function contractStore(
  ctx: ExtensionContext,
): FileContractStore {
  return new FileContractStore(
    path.join(
      findProjectRoot(ctx.cwd),
      ".phenix-agent-state",
      "contracts",
    ),
  );
}

function errorResult(
  message: string,
  details?: Record<string, unknown>,
): AgentToolResult<Record<string, unknown>> {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
    details: details ?? {
      status: "error",
    },
  };
}

function authorizeCurrentChild(
  artifact: Parameters<
    typeof authorizeContract
  >[0],
):
  | {
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly result: AgentToolResult<
        Record<string, unknown>
      >;
    } {
  const decoded = decodeContractIdentity();

  if (!decoded.ok) {
    return {
      ok: false,
      result: errorResult(
        "Contract access denied: invalid child identity.",
        {
          status: "unauthorized",
          errors: decoded.errors,
        },
      ),
    };
  }

  const authorization = authorizeContract(
    artifact,
    decoded.identity,
  );

  if (!authorization.ok) {
    return {
      ok: false,
      result: errorResult(
        `Contract access denied: ${authorization.reason}.`,
        {
          status: "unauthorized",
          reason: authorization.reason,
        },
      ),
    };
  }

  return {
    ok: true,
  };
}

function formatContractText(
  artifact: {
    readonly id: string;
    readonly task: string;
    readonly requirements: readonly string[];
    readonly outputSchema: unknown;
  },
): string {
  const requirements =
    artifact.requirements.length > 0
      ? artifact.requirements
          .map(
            (requirement, index) =>
              `${index + 1}. ${requirement}`,
          )
          .join("\n")
      : "1. Complete the delegated task exactly as specified.";

  return [
    `Contract ${artifact.id}`,
    "",
    "Task:",
    artifact.task,
    "",
    "Requirements:",
    requirements,
    "",
    "Required output JSON Schema:",
    JSON.stringify(
      artifact.outputSchema,
      null,
      2,
    ),
    "",
    "Submit the complete result with phenix_contract_submit.",
  ].join("\n");
}

export default function registerPhenixContractTools(
  pi: ExtensionAPI,
): void {
  /*
   * Always register contract tools so child sessions can access them.
   * Runtime authorization in each tool's execute handler enforces
   * that only sessions with valid contract identities can actually
   * retrieve or submit contracts.
   */

  pi.registerTool({
    name: "phenix_contract_get",
    label: "Get Phenix Contract",
    description:
      "Retrieve the authoritative delegated task, requirements, and output contract for this child process.",
    parameters: GetContractParams,

    async execute(
      _toolCallId: string,
      params: {
        id: string;
      },
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const id = parseContractId(params.id);

      if (!id) {
        return errorResult(
          "Invalid contract ID.",
          {
            status: "invalid-id",
          },
        );
      }

      const stored =
        await contractStore(ctx).load(id);

      if (!stored) {
        return errorResult(
          `Contract ${id} was not found.`,
          {
            status: "not-found",
          },
        );
      }

      const authorization =
        authorizeCurrentChild(stored.artifact);

      if (!authorization.ok) {
        return authorization.result;
      }

      return {
        content: [
          {
            type: "text",
            text:
              formatContractText(
                stored.artifact,
              ),
          },
        ],
        details: {
          status: stored.result.state,
          contract: {
            id: stored.artifact.id,
            task: stored.artifact.task,
            requirements:
              stored.artifact.requirements,
            outputSchema:
              stored.artifact.outputSchema,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "phenix_contract_submit",
    label: "Submit Phenix Contract",
    description:
      "Validate and submit the final structured result for this delegated child contract. Call this as the final action.",
    parameters: SubmitContractParams,

    async execute(
      _toolCallId: string,
      params: {
        id: string;
        value: unknown;
      },
      _signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      const id = parseContractId(params.id);

      if (!id) {
        return errorResult(
          "Invalid contract ID.",
          {
            status: "invalid-id",
          },
        );
      }

      const store = contractStore(ctx);
      const stored = await store.load(id);

      if (!stored) {
        return errorResult(
          `Contract ${id} was not found.`,
          {
            status: "not-found",
          },
        );
      }

      const authorization =
        authorizeCurrentChild(stored.artifact);

      if (!authorization.ok) {
        return authorization.result;
      }

      if (
        stored.result.state !== "pending"
      ) {
        return errorResult(
          `Contract ${id} is already ${stored.result.state}.`,
          {
            status: "already-terminal",
            state: stored.result.state,
          },
        );
      }

      const validation = validateContract(
        stored.artifact.outputSchema,
        params.value,
      );

      if (!validation.ok) {
        const summary =
          "summary" in validation
            ? validation.summary
            : "Contract validation failed.";

        return errorResult(
          [
            "Contract submission rejected.",
            summary,
            "Correct the value and call phenix_contract_submit again.",
          ].join("\n"),
          {
            status: "invalid",
            validation,
          },
        );
      }

      try {
        const submitted =
          await store.submit(
            id,
            stored.result.revision,
            params.value,
          );

        return {
          content: [
            {
              type: "text",
              text:
                "Contract accepted. Delegated task complete.",
            },
          ],
          details: {
            status: "accepted",
            contractId: id,
            revision:
              submitted.revision,
          },
          terminate: true,
        };
      } catch (error) {
        if (
          error instanceof ContractStoreError
        ) {
          return errorResult(
            error.message,
            {
              status: error.code,
            },
          );
        }

        throw error;
      }
    },
  });
}
