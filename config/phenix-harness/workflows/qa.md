# QA workflow

```phenix-workflow
id: workflow.qa
entry: fanout
```

## States

| Key | Kind | Role | Required | Join | Objective | Next |
|---|---|---|---|---|---|---|
| `fanout` | `decision` | | `optional` | `any` | | `repository; tests; architecture; security` |
| `repository` | `invoke` | `scout` | `required` | `any` | Review repository structure, integration correctness, and ownership boundaries for {objective}. Return structured evidence. | `synthesize` |
| `tests` | `invoke` | `tester` | `required` | `any` | Interpret deterministic checks, observed failures, and coverage gaps for {objective}. Return structured evidence. | `synthesize` |
| `architecture` | `invoke` | `architect` | `optional` | `any` | Independently review architecture and module boundaries for {objective}. Return structured evidence or fail explicitly if unavailable. | `synthesize` |
| `security` | `invoke` | `critic` | `optional` | `any` | Review security and trust boundaries relevant to {objective}. Return structured evidence or fail explicitly if unavailable. | `synthesize` |
| `synthesize` | `invoke` | `qa-synthesizer` | `required` | `all-settled` | Synthesize QA evidence for {objective}. Use every settled branch outcome from the workflow context, preserve successful evidence when optional branches fail, name missing evidence, and return JSON with decision set to accept or fail. | `accept if output.decision = accept; fail if output.decision = fail` |
| `accept` | `return` | | `optional` | `any` | QA accepted for {objective}; return the synthesized evidence without another model-owned finalization step. | |
| `fail` | `fail` | | `optional` | `any` | QA failed for {objective}; mandatory evidence or synthesis did not satisfy the acceptance contract. | |
