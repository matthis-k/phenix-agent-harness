# Test-driven development

```phenix-workflow
id: workflow.tdd
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `red` | | `tester` | Establish the smallest durable test seam for {objective}, add one focused test that expresses the required behavior, run the narrowest relevant test target, and prove the new test fails for the intended reason before implementation |
| `green` | `red` | `implementer` | Make the smallest coherent implementation that causes the focused test for {objective} to pass without weakening the test or broadening the requested behavior |
| `refactor` | `green` | `implementer` | Refactor the passing implementation for {objective} toward the repository's existing abstractions and deep-module boundaries while keeping the focused feedback green |
| `verify` | `refactor` | `verifier` | Run the focused test, relevant surrounding tests, type or compile checks, and the appropriate full validation for {objective}; verify the implementation satisfies the requested behavior without regression |
