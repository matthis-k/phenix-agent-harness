import { Type } from "typebox";

import { defineSchema } from "../domain/definition/schema.ts";
import type {
  UserFormDefinition,
  UserFormSuggestion,
  UserFormUrgency,
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
  readonly urgency?: UserFormUrgency;
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
    urgency: Type.Optional(Type.Enum(["normal", "urgent"])),
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
        "Queue one operator-facing form containing several related questions. Questions are fixed, only answer fields are editable, and each question may provide selectable suggestions that remain editable after selection. Forms never steal focus: they appear in the pending-form inbox and status line. The call waits for the operator to submit or cancel that specific form. Use urgency=urgent only when work is blocked and prompt operator attention is materially required.",
      parameters: userFormParameters,
      execute: async (raw, signal) => {
        const params = requireValid(raw);
        const result = await this.forms.request(
          {
            rootRunId: this.store.projection.rootOf(runId),
            requestedByRunId: runId,
            urgency: params.urgency ?? "normal",
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
