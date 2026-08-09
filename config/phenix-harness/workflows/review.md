# Independent code review

```phenix-workflow
id: workflow.review
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `standards` | | `critic` | Review {objective} only for engineering quality: repository standards, architecture, maintainability, correctness risks, tests, duplication, ownership, and inappropriate abstractions; report concrete findings with evidence |
| `spec` | | `verifier` | Review {objective} only for conformance to the stated request, specification, acceptance criteria, and intended behavior; report concrete mismatches and omit this axis explicitly when no usable specification exists |
