# Domain modeling

```phenix-workflow
id: workflow.domain-model
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `discover` | | `scout` | Collect the terminology, entities, operations, invariants, existing CONTEXT material, and contradictory names relevant to {objective} from code, tests, documentation, and conversation evidence |
| `model` | `discover` | `architect` | Sharpen the domain model for {objective}: choose canonical terms, define their boundaries and relationships, distinguish domain language from implementation vocabulary, and surface unresolved semantic conflicts |
| `challenge` | `model` | `critic` | Stress-test the proposed domain vocabulary for {objective} against actual code and user intent, rejecting aliases, overloaded terms, and abstractions that do not reduce conceptual ambiguity |
| `record` | `challenge` | `implementer` | Update the appropriate CONTEXT documentation for {objective} with only the settled domain vocabulary and relationships; do not turn the glossary into a specification or implementation guide |
| `verify` | `record` | `verifier` | Verify the recorded domain model for {objective} is internally consistent, grounded in repository usage, and free of unresolved implementation-specific assumptions |
