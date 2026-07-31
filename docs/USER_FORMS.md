# User forms

`phenix_userform` collects several related operator answers in one queued dialog.

## Agent request

The tool accepts:

- `title`: form title
- `description`: optional bounded context
- `urgency`: `normal` or `urgent`
- `submitLabel`: optional submit wording
- `questions`: one to twelve fixed questions

Each question has a stable `id`, prompt, optional description, required flag, placeholder, initial answer, and up to eight suggestions. A suggestion may be a string or a `{ label, value, description }` object.

Questions and suggestions are display data. Only answer fields are editable. Selecting a suggestion copies its value into the answer field; subsequent editing removes the suggestion identity and returns a free-text answer.

The tool call resolves only when that specific form is submitted or explicitly declined. Its result is structured by question ID.

## Inbox

Forms never open automatically or change the selected transcript. Pending forms are counted in the status surface:

```text
forms 3 pending · 1 urgent · /userforms
```

`/userforms` opens the inbox from either native Pi or the fullscreen Phenix workspace. Urgent requests appear first; requests retain FIFO order within the same urgency.

After a form is submitted or declined, the inbox reopens with the remaining requests. `Escape` from a form returns to the inbox without resolving it. `Ctrl+X` explicitly declines it.

## Dialog controls

- `Tab`, `Shift+Tab`, `Up`, `Down`: move between answer fields
- `Ctrl+Space`: open suggestions for the active question
- `Enter`: move to the next field, or submit from the final field
- `Ctrl+Enter`: submit immediately
- `Escape`: defer and return to the inbox
- `Ctrl+X`: decline the form

Required fields are validated before submission.

## Ownership

The runtime owns the queue and routes each result back to the requesting run. The extension owns inbox and status integration. The dialog owns only local draft, selection, cursor, scrolling, and validation state.

The queue is intentionally process-local. Runtime shutdown cancels pending forms because their requesting model sessions no longer exist to receive answers.
