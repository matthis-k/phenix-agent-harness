# Legacy QA workflow

```phenix-workflow
id: workflow.qa
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `fanout` | | `coordinator` | Coordinate independent QA reviews for {objective} |
| `repository` | `fanout` | `scout` | Review repository structure and correctness for {objective} |
| `tests` | `fanout` | `tester` | Interpret deterministic checks and coverage gaps for {objective} |
| `architecture` | `fanout` | `architect` | Review architecture and module boundaries for {objective} |
| `security` | `fanout` | `critic` | Review security and trust boundaries for {objective} |
| `synthesize` | `fanout` | `qa-synthesizer` | Synthesize the independent QA evidence for {objective} |
