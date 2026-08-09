# Research workflow

```phenix-workflow
id: workflow.research
entry: classify
```

## States

| Key | Kind | Role | Required | Join | Objective | Next |
|---|---|---|---|---|---|---|
| `classify` | `invoke` | `coordinator` | `required` | `any` | Classify which evidence domains are actually relevant to {objective}. Return JSON with domains containing any of repository, ecosystem, and constraints. | `repository if output.domains contains repository; ecosystem if output.domains contains ecosystem; constraints if output.domains contains constraints` |
| `repository` | `invoke` | `researcher` | `required` | `any` | Investigate repository and implementation evidence relevant to {objective}; cite concrete artifacts in the returned structured evidence. | `challenge` |
| `ecosystem` | `invoke` | `researcher` | `required` | `any` | Investigate upstream documentation and prior art relevant to {objective}; return structured evidence with source quality noted. | `challenge` |
| `constraints` | `invoke` | `researcher` | `required` | `any` | Investigate constraints, risks, and counterexamples relevant to {objective}; return structured evidence. | `challenge` |
| `challenge` | `invoke` | `critic` | `required` | `all-settled` | Challenge contradictions and unsupported conclusions for {objective}. Use settled outcomes including skipped or failed domains, and return JSON with decision set to accept or fail plus contradictions and confidence limits. | `synthesize if output.decision = accept; fail if output.decision = fail` |
| `synthesize` | `invoke` | `finalizer` | `required` | `any` | Produce the source-oriented semantic synthesis for {objective} from the classified evidence and states.challenge.output. Do not invent evidence from skipped domains. | `accept` |
| `accept` | `return` | | `optional` | `any` | Research synthesis completed for {objective}. | |
| `fail` | `fail` | | `optional` | `any` | Research could not satisfy the evidence contract for {objective}. | |
