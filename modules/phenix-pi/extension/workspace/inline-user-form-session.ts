import type { UserFormFacade } from "../../application/user-form-service.ts";
import type { RunId } from "../../domain/shared.ts";
import type { UserFormAnswer, UserFormId, UserFormRequest } from "../../domain/user-form/model.ts";

export interface InlineUserFormSnapshot {
  readonly request: UserFormRequest;
  readonly questionIndex: number;
  readonly answers: readonly UserFormAnswer[];
  readonly completed: boolean;
}

interface Draft {
  readonly answers: UserFormAnswer[];
  questionIndex: number;
}

export class InlineUserFormSession {
  private readonly forms: UserFormFacade;
  private readonly rootRunId: RunId;
  private readonly drafts = new Map<UserFormId, Draft>();
  private activeId: UserFormId | undefined;

  constructor(forms: UserFormFacade, rootRunId: RunId) {
    this.forms = forms;
    this.rootRunId = rootRunId;
  }

  pending(): readonly UserFormRequest[] {
    return orderPendingUserForms(this.forms.list(this.rootRunId));
  }

  active(): InlineUserFormSnapshot | undefined {
    const request = this.activeRequest();
    if (!request) return undefined;
    const draft = this.draftFor(request);
    return {
      request,
      questionIndex: draft.questionIndex,
      answers: [...draft.answers],
      completed: false,
    };
  }

  answer(raw: string): InlineUserFormSnapshot | undefined {
    const request = this.activeRequest();
    if (!request) return undefined;
    const draft = this.draftFor(request);
    const question = request.form.questions[draft.questionIndex];
    if (!question) return undefined;

    const answer = normalizeAnswer(question.id, raw, question.suggestions);
    draft.answers[draft.questionIndex] = answer;

    const finalQuestion = draft.questionIndex === request.form.questions.length - 1;
    if (!finalQuestion) {
      draft.questionIndex += 1;
      return {
        request,
        questionIndex: draft.questionIndex,
        answers: [...draft.answers],
        completed: false,
      };
    }

    const answers = request.form.questions.map(
      (item, index) =>
        draft.answers[index] ?? {
          questionId: item.id,
          answer: item.initialAnswer ?? "",
        },
    );
    this.forms.complete(request.id, { status: "submitted", answers });
    this.drafts.delete(request.id);
    this.activeId = undefined;
    return {
      request,
      questionIndex: draft.questionIndex,
      answers,
      completed: true,
    };
  }

  cancel(): UserFormRequest | undefined {
    const request = this.activeRequest();
    if (!request) return undefined;
    this.forms.complete(request.id, { status: "cancelled", reason: "user" });
    this.drafts.delete(request.id);
    this.activeId = undefined;
    return request;
  }

  private activeRequest(): UserFormRequest | undefined {
    const pending = this.pending();
    if (this.activeId) {
      const current = pending.find((request) => request.id === this.activeId);
      if (current) return current;
    }
    const next = pending[0];
    this.activeId = next?.id;
    return next;
  }

  private draftFor(request: UserFormRequest): Draft {
    const existing = this.drafts.get(request.id);
    if (existing) return existing;
    const draft: Draft = {
      questionIndex: 0,
      answers: request.form.questions.map((question) => ({
        questionId: question.id,
        answer: question.initialAnswer ?? "",
      })),
    };
    this.drafts.set(request.id, draft);
    return draft;
  }
}

export function orderPendingUserForms(
  requests: readonly UserFormRequest[],
): readonly UserFormRequest[] {
  return [...requests].sort((left, right) => {
    if (left.urgency !== right.urgency) return left.urgency === "urgent" ? -1 : 1;
    return left.requestedAt.localeCompare(right.requestedAt);
  });
}

function normalizeAnswer(
  questionId: string,
  raw: string,
  suggestions: UserFormRequest["form"]["questions"][number]["suggestions"],
): UserFormAnswer {
  const numeric = /^\s*(\d+)\s*$/.exec(raw);
  const selected = numeric
    ? suggestions[Number(numeric[1]) - 1]
    : suggestions.find(
        (suggestion) => suggestion.label === raw.trim() || suggestion.value === raw.trim(),
      );
  if (!selected) return { questionId, answer: raw };
  return {
    questionId,
    answer: selected.value,
    suggestionValue: selected.value,
  };
}
