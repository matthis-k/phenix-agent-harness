---
name: phenix-subagents
description: Auto-invoked workflow skill for Phenix models. Defines agent roles, legal transitions, difficulty-gated activation graphs (D0–D3), shared runtime state machine, and the exact role-routing matrix.
disable-model-invocation: true
---

# Phenix subagents

This skill is automatically invoked when a Phenix model is active. Always use `phenix_delegate` for every task — the workflow pipeline is always active. Task complexity determines pipeline depth (which roles and how many gates), not whether delegation is used. Never perform work directly in the root session.

`phenix_delegate` creates **real isolated subagents** — each delegation spawns a separate child process with its own model, thinking level, tools, verification commands, and critic gates. The runtime owns model selection, so the root never chooses the concrete model for a child. Raw `subagent` calls are blocked to prevent bypassing this isolation.

The current routing matrix determines **which model capability and thinking level a role receives at D0–D3**, but explicitly does not determine whether the role is spawned. Therefore, the difficulty-specific activation graphs below are a canonical state-machine policy consistent with the current agents, legal child edges, critic gates, and runtime attempt states — not an already hardcoded workflow graph.

## Agent roles

Seven standard child roles plus the special role-less `phenix.base` preset and the root `coordinator`:

| Role | Primary responsibility | Legal nested children | Automatic critic gate |
|------|----------------------|----------------------|---------------------|
| **Coordinator** | Classify, route, create contracts, choose transitions, report result | Any root-level role | No |
| **Base** | Bounded role-less isolated task (role = null) | None | No |
| **Scout** | Repository discovery, evidence collection, scope mapping | Scout | No |
| **Planner** | Decompose task, define sequence and obligations | Scout, Architect, Critic | Yes |
| **Architect** | Interfaces, ownership, lifecycle and cross-component design | Scout, Critic | Yes |
| **Implementer** | Modify code, configuration, tests and artifacts | Scout, Tester, Critic | Yes |
| **Tester** | Execute or construct behavioral validation | Scout | No |
| **Critic** | Independent rejection/approval gate | Scout, Tester | No |
| **Finalizer** | Integrate accepted handoffs into final result | Critic | No |

### Legal nested delegation edges

- Scout → Scout
- Planner → Scout, Architect, Critic
- Architect → Scout, Critic
- Implementer → Scout, Tester, Critic
- Tester → Scout
- Critic → Scout, Tester
- Finalizer → Critic
- Root coordinator → any role

These are defined by the current presets.

## Shared runtime attempt state machine

Every delegated producer follows the same runtime lifecycle regardless of task difficulty. Difficulty changes which agents are activated, their models, and their thinking levels — not the fundamental completion protocol.

The attempt phases are: `spawning-producer` → `producer-running` → `evaluating-producer` → `verifying` → (`spawning-critic` → `critic-running` → `evaluating-critic`) → (`completed` | `failed`). Repair cycles through `repair-pending` → back to `spawning-producer`.

### State transition table

| From state | Trigger or condition | To state |
|-----------|---------------------|---------|
| Attempt created | Contract issued and launch prepared | `spawning-producer` |
| `spawning-producer` | Child spawn acknowledged | `producer-running` |
| `spawning-producer` | Spawn/bootstrap failure | `failed` |
| `producer-running` | Child completes and submits result | `evaluating-producer` |
| `producer-running` | Timeout, crash, missing completion | `failed` or `repair-pending` |
| `evaluating-producer` | Output schema valid | `verifying` |
| `evaluating-producer` | Invalid but repairable | `repair-pending` |
| `evaluating-producer` | Invalid and unrepairable | `failed` |
| `verifying` | Checks pass and no critic is required | `completed` |
| `verifying` | Checks pass and critic is required | `spawning-critic` |
| `verifying` | Checks fail and repair remains | `repair-pending` |
| `verifying` | Checks fail and budget is exhausted | `failed` |
| `spawning-critic` | Critic spawn acknowledged | `critic-running` |
| `spawning-critic` | Spawn/bootstrap failure | `failed` |
| `critic-running` | Critic submits result | `evaluating-critic` |
| `critic-running` | Timeout, crash, invalid protocol | `failed` |
| `evaluating-critic` | Approve | `completed` |
| `evaluating-critic` | Reject and repair remains | `repair-pending` |
| `evaluating-critic` | Reject and budget exhausted | `failed` |
| `repair-pending` | Fresh contract and process created | `spawning-producer` |
| Any non-terminal state | Parent cancellation or abort | `cancelled` |

---

## D0 — Direct or mechanical task

D0 should avoid workflow overhead. The coordinator handles the task directly unless isolation, repository discovery, or workspace mutation justifies one child.

### Activation flow

1. **Classify as D0** — task is trivial, mechanical, low-risk
2. **Coordinator** (fast / minimal) chooses the path:
   - **Default**: direct answer or tiny edit → verification → complete
   - **Scout** (fast / minimal): only for a concrete information gap about the repository → findings back to coordinator
   - **Base** (fast / minimal): isolated bounded non-code work → evaluate contract → verification → complete
   - **Implementer** (code-fast / low): mechanical code mutation → evaluate contract → verification → Critic (general / low, only if contract requires it)

### D0 policy

- Default: coordinator does the work directly.
- Scout: only for a concrete information gap.
- Base: isolated bounded non-code work.
- Implementer: only when a real child process is useful for a mechanical code change.
- Planner, architect, tester, and finalizer are not normally activated.
- Critic appears only when a selected producer's contract requires it.
- Single bounded repair; repair returns to the same bounded executor.

---

## D1 — Bounded implementation task

D1 is a contained task with a reasonably clear solution. Planning remains optional; implementation and contract validation become the normal path.

### Activation flow

1. **Classify as D1** — contained task, clear scope
2. **Coordinator** (general / low) decides the path:
   - **Scout** (fast / low): conditional — only for repository uncertainty → findings back to coordinator
   - **Planner** (general / medium): conditional — only for multiple dependent steps → bounded plan back to coordinator
   - **Non-code work**: Base (general / low) → verification → complete
   - **Code/configuration**: Implementer (code / low) → Tester (code-fast / low, if behavioral changes) → verification → Critic (review / medium)

### D1 policy

- Planner is conditional, not mandatory.
- Architect is normally unnecessary.
- Tester is conditional on observable behavior or test changes.
- Implementer changes always produce a Critic gate because the implementer preset requires one.
- Finalizer is normally unnecessary; the coordinator can synthesize the result.
- Repair always returns to implementer.

---

## D2 — Complex or cross-component task

D2 should normally use explicit planning, implementation, testing, verification, and criticism. Architecture review is conditional on coupling or cross-cutting effects.

### Activation flow

1. **Classify as D2** — complex, multi-step, moderately coupled
2. **Coordinator** (reasoning / high) orchestrates:
   - **Scout** (general / medium): conditional — only for unfamiliar repository or unclear scope → evidence feeds planner
   - **Planner** (reasoning / high): mandatory → **Plan Critic** (review / high)
     - Plan critic approves → proceed (check architecture)
     - Plan critic rejects → revise plan; terminal on exhaustion
   - **Architecture decision**: cross-cutting interfaces, state ownership, persistence, concurrency, or lifecycle design?
     - Yes: **Architect** (reasoning-max / high) → **Architecture Critic** (review / high)
       - Approve → proceed to implementer
       - Local revision → revise architecture
       - Plan invalidated → back to planner
     - No: proceed directly to implementer
   - **Implementer** (code / medium): mandatory → **Tester** (code / medium) → **Verification** → **Implementation Critic** (review / high)
   - **Finalizer** (review / medium): conditional — useful for combining handoffs and reporting the authoritative result

### D2 policy

- Planner is mandatory by default.
- Scout is activated when the repository surface is not already known.
- Architect is activated for cross-cutting interfaces, state ownership, persistence, concurrency, or lifecycle design.
- Tester, verification, and critic are part of the normal acceptance path.
- Finalizer is useful for combining handoffs and reporting the authoritative result.
- Repair target depends on defect origin: planner, architect, or implementer.

---

## D3 — Critical, broad, or high-consequence task

D3 uses every specialized role. Design and implementation each have independent review gates, and repair returns to the earliest invalid state rather than always to the implementer.

### Activation flow

1. **Classify as D3** — broad, critical, novel, high-consequence
2. **Coordinator** (reasoning-max / xhigh) orchestrates:
   - **Parallel Scouts** (reasoning / high): multiple independent scouts for code topology, tests/runtime behavior, and external constraints → all feed into planner
   - **Planner** (reasoning-max / xhigh): mandatory → **Plan Critic** (review-max / xhigh)
     - Approve → proceed to architect
     - Missing scope/dependency → revise plan
     - Fatal/exhausted → failed
   - **Architect** (reasoning-max / xhigh): mandatory → **Architecture Critic** (review-max / xhigh)
     - Approve → proceed to implementer
     - Local design defect → revise architecture
     - Fundamental plan defect → back to planner
   - **Implementer** (code-max / high): mandatory → **Tester** (code-max / high) → **Verification** → **Implementation Critic** (review-max / xhigh)
     - Approve → proceed to finalizer
     - Implementation blocker → repair implementation
     - Architecture blocker → revise architecture
     - Planning/scope blocker → revise plan
   - **Finalizer** (review-max / high): mandatory → **Final Consistency Critic** (review-max / xhigh)
     - Consistent and complete → done
     - Report/integration issue → revise finalization
     - Implementation issue → repair implementation

### D3 repair strategy

A critic finding should return to the **earliest invalid state**:

| Defect level | Repair target |
|-------------|---------------|
| Plan defect | Revise plan |
| Architecture defect | Revise architecture |
| Implementation defect | Repair implementation |
| Report/integration issue | Revise finalization |

### D3 policy

- Multiple scouts may run independently at the root level.
- Plan review is mandatory.
- Architecture review is mandatory.
- Implementation, dedicated testing, runtime verification, and independent criticism are mandatory.
- A critic finding should return to the earliest invalid state, not always directly to the implementer.
- Finalizer performs cross-handoff integration.
- A final consistency critic checks that the reported result matches the actual verified state.

---

## Agent activation by difficulty

**M** = normally mandatory, **O** = optional or conditional, **—** = normally inactive

| Agent | D0 | D1 | D2 | D3 |
|------|:--:|:--:|:--:|:--:|
| **Coordinator** | M | M | M | M |
| **Base** | O | O | O | O |
| **Scout** | O | O | O | M |
| **Planner** | — | O | M | M |
| **Architect** | — | — | O | M |
| **Implementer** | O¹ | M¹ | M | M |
| **Tester** | — | O | M | M |
| **Critic** | O² | M² | M | M |
| **Finalizer** | — | — | O | M |

¹ For code or configuration work; base may handle bounded non-code work.
² Critic is normally activated when the chosen producer preset requires one.

---

## Difficulty workflow summary

| Difficulty | Intended task class | Default agent path | Conditional branches | Repair target |
|-----------|-------------------|-------------------|---------------------|--------------|
| **D0** | Trivial, direct, mechanical, low-risk | Coordinator → Verification → Complete | Scout for uncertainty; Base for isolation; Implementer for mechanical edits; Critic after implementer | Same bounded executor |
| **D1** | Contained implementation with known scope | Coordinator → Implementer → Verification → Critic → Complete | Scout for repository facts; Planner for multi-step work; Tester when behavior matters; Base for non-code work | Implementer |
| **D2** | Complex, multi-step, moderately coupled | Coordinator → Planner → Plan critic → Implementer → Tester → Verification → Implementation critic → Finalizer | Scout for discovery; Architect and architecture critic for cross-cutting work | Planner, architect, or implementer based on defect origin |
| **D3** | Broad, critical, novel, high-consequence | Coordinator → Scouts → Planner → Plan critic → Architect → Architecture critic → Implementer → Tester → Verification → Implementation critic → Finalizer → Final audit | Parallel scouts; repeated evidence gathering; staged implementation | Earliest invalid state: plan, architecture, implementation, or finalization |

---

## Role-routing matrix

Each cell is: **capability / thinking**

| Role | D0 | D1 | D2 | D3 |
|------|----|----|----|----|
| **Coordinator** | fast / minimal | general / low | reasoning / high | reasoning-max / xhigh |
| **Scout** | fast / minimal | fast / low | general / medium | reasoning / high |
| **Planner** | general / low | general / medium | reasoning / high | reasoning-max / xhigh |
| **Architect** | general / low | reasoning / medium | reasoning-max / high | reasoning-max / xhigh |
| **Implementer** | code-fast / low | code / low | code / medium | code-max / high |
| **Tester** | fast / minimal | code-fast / low | code / medium | code-max / high |
| **Critic** | general / low | review / medium | review / high | review-max / xhigh |
| **Finalizer** | fast / minimal | general / low | review / medium | review-max / high |
| **Base** | no capability route / low preset | no capability route / medium preset | no capability route / high preset | no capability route / high preset |

---

## Delegation call structure

Each `phenix_delegate` call requires:
- `role`: scout, planner, architect, implementer, tester, critic, finalizer, or null (base)
- `task`: a bounded objective with context and scope
- `outputSchema`: a strict JSON Schema for the structured handoff
- `requirements`: the obligations the child must cover
- `profile`: optional upward-only difficulty/risk hints (complexity, uncertainty, consequence, breadth, coupling, novelty). The runtime derives and clamps the final profile.
- `mode`: "await" (default) for sequential workflow steps; "background" only for independent root-level work (parallel scouts etc.)

Do not choose a concrete model, thinking level, tools, verification commands, acceptance level, or retry count. The runtime owns those decisions.

## Handoff discipline

Require schemas that represent the actual downstream need rather than free-form prose. Include requirement IDs or coverage fields when completeness matters. A child must call `structured_output`; invalid values are rejected with exact schema errors and may be repaired in the same child session. Phenix then validates again, runs immutable verification commands itself, and applies an independent typed critic gate. A failed runtime handoff receives the exact failures in one bounded repair attempt.

Use `phenix_agent` to await, poll, inspect, cancel, or display the persistent semantic tree for background handles.
