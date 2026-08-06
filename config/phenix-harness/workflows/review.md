# Legacy review workflow

```phenix-workflow
id: workflow.review
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `review` | | `verifier` | Run the invariant read-only review for {objective} |
| `synthesize` | `review` | `qa-synthesizer` | Produce the review report for {objective} |
