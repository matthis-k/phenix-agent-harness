# User forms

`phenix_userform` collects several related operator answers through the normal session input.

## Agent request

The tool accepts:

- `title`: form title
- `description`: optional bounded context
- `urgency`: `normal` or `urgent`
- `submitLabel`: optional submit wording
- `questions`: one to twelve fixed questions

Each question has a stable `id`, prompt, optional description, required flag, placeholder, initial answer, and up to eight suggestions. A suggestion may be a string or a `{ label, value, description }` object.

The tool call resolves only when that specific form is submitted or explicitly cancelled. Its result is structured by question ID.

## Inline transcript

Every pending request is appended to the root transcript as a visible section headed:

```text
User form from <requesting-run>
```

The section includes the title, context, all questions, existing answers, the currently active question, and any suggestions. Urgent forms are visibly marked. Form changes refresh the fullscreen transcript without opening or replacing the workspace.

Pending forms remain counted in the status surface, but the status is secondary:

```text
forms 3 pending · 1 urgent · answer in input
```

## Input routing

The ordinary editor is the only answer field. While a form is active, the next non-command submission answers its current question instead of being delivered to the root model or selected child session.

- Enter submits the current answer.
- A suggestion can be selected by entering its number, label, or value.
- After an answer, the next question becomes active.
- Answering the final question submits the complete form to its requesting run.
- Slash commands remain commands and are never consumed as answers.
- `/userforms` shows the active question.
- `/userform-cancel` explicitly cancels the active form.

Forms are selected urgent-first and FIFO within the same urgency. Once a form is active, a later urgent request does not replace it mid-answer.

## Ownership

The runtime owns the queue and routes each completed result back to the requesting run. The inline session owns only active-form identity and draft answers. The extension projects requests and progress into the transcript and intercepts ordinary user input before agent routing.

The queue is intentionally process-local. Runtime shutdown cancels pending forms because their requesting model sessions no longer exist to receive answers.
