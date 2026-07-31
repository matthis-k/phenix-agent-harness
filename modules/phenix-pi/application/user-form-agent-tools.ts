import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";
import type {
  UserFormDefinition,
  UserFormSuggestion,
} from "../domain/user-form/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { AgentTool } from "../ports/agent-session-backend.ts";
import type { AgentToolFactory } from "./agent-tools.ts";
import type { ExecutionStore } from "./execution-store.ts";
import type { UserFormFacade } from "./user-form-service.ts";

interface UserFormParameters {
  readonly title: string;
  readonly description?: string;
  readonly submitLabel?: string;
  readonly questions: Array<{
    readonly id: string;
    readonly prompt: string;
    readonly description?: string;
    readonly required?: boolean;
    readonly placeholder?: string;
    readonly initialAnswer?: string;
    readonly suggestions?: Array<
      | string
      | {
          readonly label: string;
          readonly value?: string;
          readonly description?: string;
        }
    >;
  }>;
}

const suggestionSchema = Type.Union([
  Type.String({ minLength: 1, maxLength: 240 }),
  Type.Object({
    label: Type.String({ minLength: 1, maxLength: 240 }),
    value: Type.Optional(Type.String({ maxLength: 16_000 })),
    description: Type.Optional(Type.String({ maxLength: 500 })),
  }),
]);

const userFormParameters = defineSchema<UserFormParameters>(
  "tool.phenix-userform",
  Type.Object({
    title: Type.String({ minLength: 1, maxLength: 160 }),
    description: Type.Optional(Type.String({ maxLength: 2_000 })),
    submitLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    questions: Type.Array(
      Type.Object({
        id: Type.String({ minLength: 1, maxLength: 80 }),
        prompt: Type.String({ minLength: 1, maxLength: 1_000 }),
        description: Type.Optional(Type.String({ maxLength: 2_000 })),
        required: Type.Optional(Type.Boolean()),
        placeholder: Type.Optional(Type.String({ maxLength: 240 })),
        initialAnswer: Type.Optional(Type.String({ maxLength: 16_000 })),
        suggestions: Type.Optional(Type.Array(suggestionSchema, { maxItems: 8 })),
      }),
      { minItems: 1, maxItems: 12 },
    ),
  }),
);

export class UserFormAgentToolFactory implements AgentToolFactory {
  private readonly forms: UserFormFacade;
  private readonly store: ExecutionStore;

  constructor(forms: UserFormFacade, store: ExecutionStore) {
    this.forms = forms;
    this.store = store;
  }

  async forRun(runId: RunId): Promise<readonly AgentTool[]> {
    const tool: AgentTool = {
      name: "phenix_userform",
      label: "Phenix User Form",
      description:
        "Ask the operator several related questions in one modal form. Questions are fixed, only answer fields are editable, and each question may provide selectable suggestions that remain editable after selection. The call waits for a structured submitted or cancelled result. Prefer one coherent form over a sequence of chat questions when the answers can be collected together.",
      parameters: userFormParameters,
      execute: async (raw, signal) => {
        const params = requireValid(raw);
        const result = await this.forms.request(
          {
            rootRunId: this.store.projection.rootOf(runId),
            requestedByRunId: runId,
            form: definitionFrom(params),
          },
          signal,
        );
        return { text: JSON.stringify(result), details: result };
      },
    };
    return [tool];
  }
}

function definitionFrom(params: UserFormParameters): UserFormDefinition {
  return {
    title: params.title,
    ...(params.description !== undefined ? { description: params.description } : {}),
    submitLabel: params.submitLabel ?? "Submit",
    questions: params.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      ...(question.description !== undefined ? { description: question.description } : {}),
      required: question.required ?? false,
      ...(question.placeholder !== undefined ? { placeholder: question.placeholder } : {}),
      ...(question.initialAnswer !== undefined
        ? { initialAnswer: question.initialAnswer }
        : {}),
      suggestions: (question.suggestions ?? []).map(normalizeSuggestion),
    })),
  };
}

function normalizeSuggestion(
  suggestion: UserFormParameters["questions"][number]["suggestions"] extends Array<infer Item>
    ? Item
    : never,
): UserFormSuggestion {
  if (typeof suggestion === "string") {
    return { label: suggestion, value: suggestion };
  }
  return {
    label: suggestion.label,
    value: suggestion.value ?? suggestion.label,
    ...(suggestion.description !== undefined ? { description: suggestion.description } : {}),
  };
}

function requireValid(value: unknown): UserFormParameters {
  const validation = userFormParameters.validate(value);
  if (!validation.ok) {
    throw new Error(validation.issues.map((issue) => `${issue.path} ${issue.message}`).join("; "));
  }
  return validation.value;
}
