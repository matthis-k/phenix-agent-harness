import type { RunId } from "../shared.ts";

export type UserFormId = string & { readonly __brand: "UserFormId" };
export type UserFormUrgency = "normal" | "urgent";

export interface UserFormSuggestion {
  readonly label: string;
  readonly value: string;
  readonly description?: string;
}

export interface UserFormQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly description?: string;
  readonly required: boolean;
  readonly placeholder?: string;
  readonly initialAnswer?: string;
  readonly suggestions: readonly UserFormSuggestion[];
}

export interface UserFormDefinition {
  readonly title: string;
  readonly description?: string;
  readonly submitLabel: string;
  readonly questions: readonly UserFormQuestion[];
}

export interface UserFormRequest {
  readonly id: UserFormId;
  readonly rootRunId: RunId;
  readonly requestedByRunId: RunId;
  readonly urgency: UserFormUrgency;
  readonly form: UserFormDefinition;
  readonly requestedAt: string;
}

export interface UserFormAnswer {
  readonly questionId: string;
  readonly answer: string;
  readonly suggestionValue?: string;
}

export type UserFormCompletion =
  | { readonly status: "submitted"; readonly answers: readonly UserFormAnswer[] }
  | { readonly status: "cancelled"; readonly reason: "user" };

export type UserFormResult =
  | {
      readonly status: "submitted";
      readonly answers: readonly UserFormAnswer[];
      readonly submittedAt: string;
    }
  | {
      readonly status: "cancelled";
      readonly reason: "user" | "runtime-shutdown";
      readonly cancelledAt: string;
    };

export interface UserFormCounts {
  readonly total: number;
  readonly urgent: number;
}

export function userFormId(value: string): UserFormId {
  if (!value || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`user form ID contains unsupported characters: ${value}`);
  }
  return value as UserFormId;
}
