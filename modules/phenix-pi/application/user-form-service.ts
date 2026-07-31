import type {
  UserFormAnswer,
  UserFormCompletion,
  UserFormDefinition,
  UserFormId,
  UserFormQuestion,
  UserFormRequest,
  UserFormResult,
  UserFormSuggestion,
} from "../domain/user-form/model.ts";
import { userFormId } from "../domain/user-form/model.ts";
import type { RunId } from "../domain/shared.ts";
import type { Clock, IdGenerator } from "../ports/clock.ts";

const MAX_QUESTIONS = 12;
const MAX_SUGGESTIONS = 8;
const MAX_ANSWER_LENGTH = 16_000;

export interface UserFormFacade {
  request(
    input: {
      readonly rootRunId: RunId;
      readonly requestedByRunId: RunId;
      readonly form: UserFormDefinition;
    },
    signal?: AbortSignal,
  ): Promise<UserFormResult>;
  next(rootRunId: RunId): UserFormRequest | undefined;
  complete(id: UserFormId, completion: UserFormCompletion): void;
  subscribe(listener: () => void): () => void;
  shutdown(): void;
}

interface PendingForm {
  readonly request: UserFormRequest;
  readonly resolve: (result: UserFormResult) => void;
  readonly reject: (error: Error) => void;
  readonly detachAbort: () => void;
}

export class UserFormService implements UserFormFacade {
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly queue: UserFormId[] = [];
  private readonly pending = new Map<UserFormId, PendingForm>();
  private readonly listeners = new Set<() => void>();
  private closed = false;

  constructor(ids: IdGenerator, clock: Clock) {
    this.ids = ids;
    this.clock = clock;
  }

  request(
    input: {
      readonly rootRunId: RunId;
      readonly requestedByRunId: RunId;
      readonly form: UserFormDefinition;
    },
    signal?: AbortSignal,
  ): Promise<UserFormResult> {
    if (this.closed) return Promise.reject(new Error("User form runtime is shut down"));
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const request: UserFormRequest = {
      id: userFormId(this.ids.next("userform")),
      rootRunId: input.rootRunId,
      requestedByRunId: input.requestedByRunId,
      form: normalizeForm(input.form),
      requestedAt: this.clock.now(),
    };

    return new Promise<UserFormResult>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.remove(request.id)) return;
        reject(abortError(signal));
        this.emit();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, {
        request,
        resolve,
        reject,
        detachAbort: () => signal?.removeEventListener("abort", onAbort),
      });
      this.queue.push(request.id);
      this.emit();
    });
  }

  next(rootRunId: RunId): UserFormRequest | undefined {
    for (const id of this.queue) {
      const candidate = this.pending.get(id)?.request;
      if (candidate?.rootRunId === rootRunId) return candidate;
    }
    return undefined;
  }

  complete(id: UserFormId, completion: UserFormCompletion): void {
    const item = this.pending.get(id);
    if (!item) return;
    const result: UserFormResult =
      completion.status === "submitted"
        ? {
            status: "submitted",
            answers: normalizeAnswers(item.request.form, completion.answers),
            submittedAt: this.clock.now(),
          }
        : {
            status: "cancelled",
            reason: "user",
            cancelledAt: this.clock.now(),
          };
    this.remove(id);
    item.resolve(result);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    const cancelledAt = this.clock.now();
    for (const id of [...this.queue]) {
      const item = this.pending.get(id);
      if (!item) continue;
      this.remove(id);
      item.resolve({ status: "cancelled", reason: "runtime-shutdown", cancelledAt });
    }
    this.emit();
    this.listeners.clear();
  }

  private remove(id: UserFormId): boolean {
    const item = this.pending.get(id);
    if (!item) return false;
    item.detachAbort();
    this.pending.delete(id);
    const index = this.queue.indexOf(id);
    if (index >= 0) this.queue.splice(index, 1);
    return true;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function normalizeForm(form: UserFormDefinition): UserFormDefinition {
  const title = requireText("form title", form.title, 160);
  if (form.questions.length === 0 || form.questions.length > MAX_QUESTIONS) {
    throw new Error(`A user form must contain between 1 and ${MAX_QUESTIONS} questions`);
  }
  const questions = form.questions.map(normalizeQuestion);
  const ids = new Set(questions.map((question) => question.id));
  if (ids.size !== questions.length) throw new Error("User form question IDs must be unique");
  return {
    title,
    ...(form.description?.trim()
      ? { description: requireText("form description", form.description, 2_000) }
      : {}),
    submitLabel: requireText("submit label", form.submitLabel || "Submit", 80),
    questions,
  };
}

function normalizeQuestion(question: UserFormQuestion): UserFormQuestion {
  const suggestions = question.suggestions.map(normalizeSuggestion);
  if (suggestions.length > MAX_SUGGESTIONS) {
    throw new Error(`Question ${question.id} has more than ${MAX_SUGGESTIONS} suggestions`);
  }
  const id = requireIdentifier("question ID", question.id);
  return {
    id,
    prompt: requireText(`question ${id}`, question.prompt, 1_000),
    ...(question.description?.trim()
      ? { description: requireText(`question ${id} description`, question.description, 2_000) }
      : {}),
    required: question.required,
    ...(question.placeholder?.trim()
      ? { placeholder: requireText(`question ${id} placeholder`, question.placeholder, 240) }
      : {}),
    ...(question.initialAnswer !== undefined
      ? { initialAnswer: requireAnswer(`question ${id} initial answer`, question.initialAnswer) }
      : {}),
    suggestions,
  };
}

function normalizeSuggestion(suggestion: UserFormSuggestion): UserFormSuggestion {
  return {
    label: requireText("suggestion label", suggestion.label, 240),
    value: requireAnswer("suggestion value", suggestion.value),
    ...(suggestion.description?.trim()
      ? { description: requireText("suggestion description", suggestion.description, 500) }
      : {}),
  };
}

function normalizeAnswers(
  form: UserFormDefinition,
  answers: readonly UserFormAnswer[],
): readonly UserFormAnswer[] {
  const byId = new Map<string, UserFormAnswer>();
  for (const answer of answers) {
    if (byId.has(answer.questionId)) {
      throw new Error(`User form contains duplicate answer ${answer.questionId}`);
    }
    byId.set(answer.questionId, answer);
  }
  return form.questions.map((question) => {
    const submitted = byId.get(question.id);
    const answer = requireAnswer(`answer ${question.id}`, submitted?.answer ?? "");
    if (question.required && !answer.trim()) {
      throw new Error(`Question ${question.id} requires an answer`);
    }
    const suggestionValue = submitted?.suggestionValue;
    const selected = suggestionValue
      ? question.suggestions.find((suggestion) => suggestion.value === suggestionValue)
      : undefined;
    return {
      questionId: question.id,
      answer,
      ...(selected && selected.value === answer ? { suggestionValue: selected.value } : {}),
    };
  });
}

function requireIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(normalized)) {
    throw new Error(`${name} contains unsupported characters: ${value}`);
  }
  return normalized;
}

function requireText(name: string, value: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  return normalized;
}

function requireAnswer(name: string, value: string): string {
  if (value.length > MAX_ANSWER_LENGTH) throw new Error(`${name} is too long`);
  return value;
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("User form request aborted");
}
