# Quality assurance and repair

```phenix-workflow
id: phenix.qa-fix
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `analysis` | | `verifier` | Reproduce and classify problems for {objective} |
| `implementation` | `analysis` | `implementer` | Fix the verified problems for {objective} |
| `verification` | `implementation` | `verifier` | Verify fixes and regressions for {objective} |
