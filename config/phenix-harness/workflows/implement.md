# Spec-driven implementation

```phenix-workflow
id: workflow.implement
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `context` | | `scout` | Recover the settled specification, ticket, acceptance criteria, existing seams, and relevant implementation context for {objective}; surface contradictions but do not redesign settled intent |
| `red` | `context` | `tester` | Establish the smallest durable test seam for {objective}, add focused failing coverage for the required behavior, and prove the failure is caused by the missing behavior rather than broken setup |
| `green` | `red` | `implementer` | Implement the smallest coherent change for {objective} that satisfies the focused test while respecting the already-agreed interfaces and repository abstractions |
| `refactor` | `green` | `implementer` | Refactor the passing implementation for {objective} to reduce duplication and improve boundaries without changing the agreed behavior; keep focused validation green throughout |
| `standards-review` | `refactor` | `critic` | Independently review the implementation for {objective} against repository standards, architecture, maintainability, tests, and code quality without judging whether the original request was the right request |
| `spec-review` | `refactor` | `verifier` | Independently verify the implementation for {objective} against the settled specification and acceptance criteria without merging or re-ranking standards findings |
