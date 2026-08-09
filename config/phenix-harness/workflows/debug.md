# Debug workflow

```phenix-workflow
id: workflow.debug
entry: reproduce
```

## States

| Key | Kind | Role | Required | Join | Objective | Next |
|---|---|---|---|---|---|---|
| `reproduce` | `invoke` | `reproducer` | `required` | `any` | Reproduce {objective} without mutating the implementation. Return JSON with status set to reproduced, causal_evidence, or inconclusive and include concrete evidence. | `diagnose if output.status = reproduced; diagnose if output.status = causal_evidence; inconclusive if output.status = inconclusive` |
| `diagnose` | `invoke` | `critic` | `required` | `any` | Establish the causal root cause of {objective} from states.reproduce.output before proposing a repair. | `implement` |
| `implement` | `invoke` | `implementer` | `required` | `any` | Apply a bounded root-cause repair for {objective} using the reproduced causal evidence; do not broaden scope. | `regression` |
| `regression` | `invoke` | `tester` | `required` | `any` | Exercise the original scenario and relevant regressions for {objective}. Return JSON with decision set to accept, repair, or fail and actionable findings. | `accept if output.decision = accept; repair if output.decision = repair; fail if output.decision = fail` |
| `repair` | `invoke` | `implementer` | `required` | `any` | Repair only the failed regression findings for {objective}. | `recheck` |
| `recheck` | `invoke` | `tester` | `required` | `any` | Re-run only the failed regression checks for {objective}. Return JSON with decision set to accept, repair, or fail. | `accept if output.decision = accept; fail if output.decision = repair; fail if output.decision = fail` |
| `inconclusive` | `return` | | `optional` | `any` | Reproduction for {objective} was inconclusive. No mutation was performed; return the evidence needed for follow-up. | |
| `accept` | `return` | | `optional` | `any` | Debug repair accepted for {objective} with reproduction and regression evidence. | |
| `fail` | `fail` | | `optional` | `any` | Debug acceptance failed for {objective} after the bounded repair budget. | |
