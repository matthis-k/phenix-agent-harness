# Workflow failure and recovery policy

Workflow failure is part of the public execution contract. A workflow must distinguish an invalid execution, an unmet quality gate, an unavailable dependency, and a failed presentation step instead of treating every unsuccessful child as the same incident.

The default rule is conservative: preserve completed typed work, but never convert incomplete or unverified work into success.

## Failure classes

| Failure class | Examples | Valid terminal failure? | Automatic response |
|---|---|---:|---|
| Definition or runtime invariant | Unknown node, invalid graph, schema mismatch, definition drift, unreachable terminal state | Yes | Fail immediately. These indicate a programming or deployment defect and must not be retried. |
| Invalid task or contract input | Input cannot satisfy the declared schema or requested operation is structurally invalid | Yes | Fail immediately. Retrying the same input cannot repair it. |
| Required authority unavailable | Missing required tool, insufficient permissions, unavailable mutation capability | Yes | Fail without automatic retry. The environment or configuration must change first. |
| External transient failure | Provider startup failure, model temporarily unavailable, transport failure | Sometimes | Retry only an awaited idempotent state with an explicit bounded retry policy. |
| Resource exhaustion | Timeout, turn budget, tool budget, missing completion after bounded repair cycles | Sometimes | Preserve the original activation and apply only validated bounded limit suggestions. Suspend for user authority when the requested increase exceeds automatic policy. |
| Deterministic check failure | Test, type, lint, build, or repository gate reports `ok: false` | Depends on workflow | Preserve as typed evidence. QA may continue and report it; a mutation workflow must not claim acceptance without a passing verification gate. |
| Quality rejection | Independent verifier rejects an implementation after bounded repair attempts | Yes | Fail as a valid negative result. Do not retry the side-effecting implementation activation automatically. |
| Strict branch failure | One required branch of an `all-success` join fails after its retry policy | Yes | Fail the workflow. Missing a required architecture, security, test, or evidence branch would make the result incomplete. |
| Final handoff failure | Finalizer or QA synthesizer fails after all substantive stages succeeded | No, when a deterministic typed fallback exists | Return a degraded typed handoff containing the validated stage results and an explicit unresolved finalizer diagnostic. |
| Cancellation | User, parent, or supervisor cancels the run | Yes | Propagate cancellation. Never retry or activate a failure fallback. |

## Safety invariants

1. **Retries are opt-in and bounded.** Only awaited invocation states declaring `retry: retryable` may replace a failed child, and only when the resulting child failure is marked retryable.
2. **Mutations are not replayed automatically.** Side-effecting implementation states omit automatic retry unless the operation is independently proven idempotent.
3. **Fallback is not recovery by re-execution.** A handoff fallback is a deterministic return mapping over schema-validated results that already exist.
4. **Fallback accepts failure only.** Cancellation remains cancellation and cannot be converted into a successful degraded result.
5. **Substantive gates remain authoritative.** Verification, audit, regression, scenario, challenge, and strict join failures remain terminal.
6. **Degraded success is explicit.** A fallback output records the finalizer failure in `unresolved` or as a QA informational finding; it does not silently report a clean result.
7. **Capabilities do not expand during recovery.** Retry and fallback retain the original activation, definition, input, causation, and authority boundaries.
8. **Historical attempts remain immutable.** Replacement attempts reference `retryOf`; successful siblings and prior typed results remain authoritative.

## Production workflow matrix

| Workflow | Terminal failures that remain valid | Degraded fallback |
|---|---|---|
| `workflow.implement` | Difficulty/plan failure after retry, unavailable implementation tools, implementation failure, deterministic D0 rejection, verifier failure after retry, exhausted bounded repair loop | None. The workflow must not return success without accepted implementation evidence. |
| `workflow.qa` | Local check infrastructure failure, required review branch failure after retry, strict `all-success` join failure | If only `agent.qa-synthesizer` fails after retry, return checks and all validated branch reports with a synthesis diagnostic. |
| `workflow.review` | Any failure propagated from `workflow.qa` | Inherits the QA synthesis fallback through composition. |
| `workflow.debug` | Reproduction, diagnosis, implementation, or regression failure | If only the finalizer fails, return reproduction, diagnosis, implementation, and regression results directly. |
| `workflow.refactor` | Characterization, architecture, implementation, or preservation review failure | If only the finalizer fails, return the validated refactor stages directly. |
| `workflow.migrate` | Inventory, plan, implementation, or migration audit failure | If only the finalizer fails, return the validated migration stages directly. |
| `workflow.ui-change` | Inspection, invariant design, implementation, scenario, or UX critique failure | If only the finalizer fails, return the validated UI stages directly. |
| `workflow.design` | Inspection, alternatives, architecture, or critique failure | If only the finalizer fails, return the validated design stages directly. |
| `workflow.research` | Any required investigation branch, strict join, or contradiction challenge failure | If only the finalizer fails, return the validated investigations and challenge directly. |
| `workflow.security` | Surface mapping, threat model, or adversarial validation failure | If only the finalizer fails, return the validated security stages directly. |

## Authoring guidance

A failure edge should be added only when the target return node can produce the workflow's declared output from already completed typed state. The fallback must not infer missing evidence, skip an acceptance gate, or invoke additional mutable work.

Use a deterministic return fallback when all of the following hold:

- every substantive state required for correctness has succeeded;
- only a presentation, synthesis, or handoff invocation failed;
- the workflow context contains enough validated outputs to construct its public schema;
- the fallback clearly records the degraded condition.

Do not add a fallback merely to improve completion rate. A terminal failure is correct whenever returning success would overstate what the workflow established.

## Known classification limitations

Explicit workflow `fail` nodes currently use the same `workflow_exhausted` failure code as orchestration limits and failed strict joins. This is operationally safe but semantically coarse: an implementation rejected by its verifier is a valid quality rejection, not necessarily an orchestration-budget exhaustion. A future change should introduce a distinct typed rejection code after auditing all failure-code consumers and health projections.

Agent-reported failures currently default an omitted `retryable` field to `true`. That preserves existing recovery behavior, but it means categories such as `invalid_task` or `insufficient_permissions` can be retried when an agent omits the field. Workflow and agent prompts should set `retryable: false` for structural blockers. A future typed policy should derive safe defaults from the failure category after auditing existing agents and tests.

These limitations are documented rather than changed here so the handoff-resilience patch does not silently alter established failure-code or retry-policy consumers.
