# Evidence-driven diagnosis

```phenix-workflow
id: workflow.debug
```

## Steps

| Key | Parent | Role | Objective |
|---|---|---|---|
| `reproduce` | | `tester` | Build the smallest red-capable feedback loop for {objective}, reproduce the failure reliably, and capture the exact observable evidence before changing production code |
| `minimize` | `reproduce` | `tester` | Minimize the reproducer for {objective} while preserving the failure so unrelated variables and slow feedback are removed |
| `hypothesize` | `minimize` | `critic` | Rank a small set of falsifiable root-cause hypotheses for {objective}, explicitly stating what observation would support or reject each one |
| `instrument` | `hypothesize` | `tester` | Add the narrowest instrumentation or experiment needed to discriminate the leading hypotheses for {objective}, then record the resulting evidence |
| `fix` | `instrument` | `implementer` | Apply the smallest root-cause repair justified by the evidence for {objective}; do not patch symptoms or broaden the change beyond the demonstrated cause |
| `regression` | `fix` | `verifier` | Re-run the minimized reproducer, preserve it as regression coverage where appropriate, and exercise relevant surrounding behavior to verify {objective} is fixed without regression |
| `finalize` | `regression` | `finalizer` | Summarize the reproduction, causal evidence, repair, and regression evidence for {objective}, clearly separating observed facts from any remaining uncertainty |
