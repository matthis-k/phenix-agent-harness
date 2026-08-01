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
| Quality rejection | Independent verifier rejects an implementation after bounded repair attempts | Yes | Fail with `workflow_rejected`. Do not retry the side-effecting implementation activation automatically. |
| Strict branch failure | One required branch of an `all-success` join fails after its retry policy | Yes | Fail with `workflow_rejected`. Missing a required architecture, security, test, or evidence branch would make the result incomplete. |
| Final handoff failure | Finalizer or QA synthesizer fails after all substantive stages succeeded | No, when a deterministic typed fallback exists | Return a degraded typed handoff containing the validated stage results and an explicit unresolved finalizer diagnostic. |
| Cancellation | User, parent, or supervisor cancels the run | Yes | Propagate cancellation. Never retry or activate a failure fallback. |

## Safety invariants

1. **Retries are opt-in and bounded.** Only awaited invocation states declaring `retry: retryable` may replace a failed child, and only when the resulting child failure is marked retryable. Omitted agent retryability is derived conservatively from the failure category rather than assumed true.
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

## Typed classification and retry defaults

`workflow_exhausted` is reserved for an exhausted orchestration mechanism, such as the workflow node-activation limit. It does not describe a valid negative quality result.

`workflow_rejected` represents a deliberate terminal rejection produced by a workflow fail node or a failed required branch of an `all-success` join. This keeps verifier rejection, deterministic acceptance failure, and incomplete strict evidence distinct from runtime exhaustion.

When an agent omits `retryable`, the runtime derives the default from the structured category:

| Category | Default | Rationale |
|---|---:|---|
| `external_failure` | Retryable | Provider and transport failures may be transient. |
| `resource_limit` with at least one concrete suggested limit | Retryable | A replacement attempt can apply a validated limit change. |
| `resource_limit` without a concrete suggestion | Not retryable | Repeating the same limits cannot repair the failure. |
| `blocked`, `deadlock`, `insufficient_permissions`, `invalid_task`, `other` | Not retryable | The input, authority, dependency, or execution plan must change first. |

An explicit `retryable` value remains authoritative. This permits a caller or agent to mark an unusual structural incident transient, but omission can no longer accidentally enable automatic retry.
