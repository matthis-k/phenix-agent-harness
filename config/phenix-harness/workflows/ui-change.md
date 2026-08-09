# UI change workflow

```phenix-workflow
id: workflow.ui-change
entry: inspect
```

## States

| Key | Kind | Role | Required | Join | Objective | Next |
|---|---|---|---|---|---|---|
| `inspect` | `invoke` | `scout` | `required` | `any` | Inspect interaction, rendering, focus, input, and state paths for {objective}. | `design` |
| `design` | `invoke` | `architect` | `required` | `any` | Specify layout, focus, input, rendering, and update invariants for {objective}. | `implement` |
| `implement` | `invoke` | `implementer` | `required` | `any` | Implement {objective} against states.design.output without changing unrelated interaction contracts. | `scenarios` |
| `scenarios` | `invoke` | `tester` | `required` | `any` | Exercise framework-appropriate UI scenarios for {objective}. Return JSON with decision set to accept, repair, or fail and actionable failed scenarios. | `critique if output.decision = accept; scenario-repair if output.decision = repair; fail if output.decision = fail` |
| `scenario-repair` | `invoke` | `implementer` | `required` | `any` | Repair only the failed UI scenarios for {objective}. | `scenario-recheck` |
| `scenario-recheck` | `invoke` | `tester` | `required` | `any` | Re-run only the repaired UI scenarios for {objective}. Return JSON with decision set to accept, repair, or fail. | `critique if output.decision = accept; fail if output.decision = repair; fail if output.decision = fail` |
| `critique` | `invoke` | `critic` | `required` | `any` | Independently review interaction quality, predictability, and state consistency for {objective}. Return JSON with decision set to accept, repair, or fail and actionable findings. | `accept if output.decision = accept; critique-repair if output.decision = repair; fail if output.decision = fail` |
| `critique-repair` | `invoke` | `implementer` | `required` | `any` | Repair only the interaction-quality findings for {objective}. | `critique-recheck` |
| `critique-recheck` | `invoke` | `critic` | `required` | `any` | Recheck only the repaired interaction-quality findings for {objective}. Return JSON with decision set to accept, repair, or fail. | `accept if output.decision = accept; fail if output.decision = repair; fail if output.decision = fail` |
| `accept` | `return` | | `optional` | `any` | UI change accepted for {objective}; return the scenario and interaction evidence without another finalizer session. | |
| `fail` | `fail` | | `optional` | `any` | UI change acceptance failed for {objective} after the bounded repair budget. | |
