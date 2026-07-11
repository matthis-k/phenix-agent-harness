# Level 2 — Readability and Local Design

Determine whether the code is understandable and locally well-designed. Combine deterministic Level 1 evidence with source-level review.

## Inspection points

- Whether function and variable names communicate domain intent.
- Whether local variables name meaningful decisions.
- Whether conditions contain several unrelated domain concepts.
- Whether complex boolean expressions should be decomposed.
- Whether control flow is unnecessarily nested.
- Whether early returns would simplify reasoning.
- Whether mutation is distributed across many branches.
- Whether one function mixes several abstraction levels.
- Whether error handling obscures the primary operation.
- Whether comments compensate for unclear code.
- Whether helper extraction would clarify intent (vs. merely moving complexity elsewhere).
- Whether data transformations are explicit and traceable.
- Whether state transitions are clear.
- Whether temporary values are meaningfully named.
- Whether function signatures communicate assumptions and ownership.

## Example: Domain predicates

Prefer:

```ts
const isActiveWorker =
  worker.kind === "agent" &&
  worker.state !== "completed" &&
  worker.state !== "failed";

const isTerminalMessage =
  message.type === "result" ||
  message.type === "error";

const isExpectedSender =
  message.senderId === worker.id;

if (isActiveWorker && isTerminalMessage && isExpectedSender) {
```

over a single condition containing several domain decisions.

## When to extract a local variable or predicate

A local variable or predicate should:

- Name a domain concept.
- Remove repeated logic.
- Isolate a decision.
- Clarify control flow.
- Make testing easier.
- Reduce cognitive load.

Do **not** recommend local variables merely to shorten a line.

## Anti-patterns to avoid flagging

These are not defects:

- A long function that is a single, linear sequence of related steps.
- A switch/match statement with many cases that are all the same abstraction level.
- Using language idioms that are conventional in the ecosystem.
- Generated code (mark as excluded from review).

## Avoid

- Stylistic findings with no concrete maintenance benefit.
- "Consider renaming X to Y" when both names are reasonable.
- "This function is too long" with no further analysis.
- Premature abstraction recommendations.
