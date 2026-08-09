# Implementation workflow

```phenix-workflow
id: workflow.implement
entry: route-plan
```

## States

| Key | Kind | Role | Required | Join | Objective | Next |
|---|---|---|---|---|---|---|
| `route-plan` | `decision` | | `optional` | `any` | | `plan if input.implementation.plan missing; implement if input.implementation.plan exists` |
| `plan` | `invoke` | `planner` | `required` | `any` | Create the implementation plan for {objective}. Return the executable plan as structured JSON. | `implement` |
| `implement` | `invoke` | `implementer` | `required` | `any` | Implement {objective}. Treat input.implementation.plan as authoritative when present; otherwise use states.plan.output. Do not re-plan. | `verify` |
| `verify` | `invoke` | `verifier` | `required` | `any` | Independently verify {objective}. Return JSON with decision set to accept, repair, or fail and include actionable findings. | `accept if output.decision = accept; repair if output.decision = repair; fail if output.decision = fail` |
| `repair` | `invoke` | `implementer` | `required` | `any` | Repair only the verifier findings for {objective}; preserve the accepted plan and unrelated behavior. | `recheck` |
| `recheck` | `invoke` | `verifier` | `required` | `any` | Recheck only the repaired verification findings for {objective}. Return JSON with decision set to accept, repair, or fail. | `accept if output.decision = accept; fail if output.decision = repair; fail if output.decision = fail` |
| `accept` | `return` | | `optional` | `any` | Implementation accepted for {objective}. | |
| `fail` | `fail` | | `optional` | `any` | Implementation acceptance failed for {objective}. | |
