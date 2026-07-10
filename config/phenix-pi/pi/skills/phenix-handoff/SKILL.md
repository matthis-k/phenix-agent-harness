---
name: phenix-handoff
description: Handoff protocol for Phenix workflow subagents — call phenix_handoff to complete your phase.
---

# Phenix Handoff Protocol

Complete your assigned work, then call `phenix_handoff` to submit your phase result.

Your handoff is the authoritative phase output. A final prose message does **not** complete the phase.

## How to handoff

Call the `phenix_handoff` tool with a JSON string containing your handoff submission.

The tool validates your submission, checks workflow correlation, stores an immutable artifact, and returns acceptance or rejection.

## Handoff kinds by role

| Role | Handoff kind | Required fields |
| ------ | ------------- | ----------------- |
| Scout | `scout-result` | kind, schemaVersion, runId, stepId, effectId, attempt, relevantFiles, editPoints, constraints, risks, recommendation |
| Planner | `plan` | kind, schemaVersion, runId, stepId, effectId, attempt, objective, steps, acceptanceCriteria, nonGoals |
| Worker | `worker-result` | kind, schemaVersion, runId, stepId, effectId, attempt, summary, completedPlanSteps, claimedChangedFiles, unresolvedIssues, verificationNotes |
| Verifier | `verification-report` | kind, schemaVersion, runId, stepId, effectId, attempt, subjectManifestDigest, reviewedFiles, criterionResults, findings, recommendation |
| Repair | `repair-result` | kind, schemaVersion, runId, stepId, effectId, attempt, addressedFindingIds, summary, claimedChangedFiles, remainingIssues |

## Identity fields

Every submission must include these identity fields:

```json
{
  "schemaVersion": 1,
  "runId": "<provided in your task>",
  "stepId": "<provided in your task>",
  "effectId": "<provided in your task>",
  "attempt": <provided in your task>
}
```

Do **not** invent these values. Use the exact values provided in your phase prompt.

## Guidelines

- Keep the handoff concise: include decisions, changed paths, criterion IDs, findings, and unresolved issues
- Do **not** copy source files, command logs, or the full conversation
- Reference stored artifacts by ID when possible
- Do **not** claim files you did not inspect or change
- Treat rejection from the tool as actionable feedback — correct the stated issue and resubmit
- Do not include hidden reasoning or chain-of-thought in the handoff
- Include only facts needed by the next phase

## Example worker handoff

```json
{
  "kind": "worker-result",
  "schemaVersion": 1,
  "runId": "abc123",
  "stepId": "Implement plan",
  "effectId": "abc123:2:Implementation:0",
  "attempt": 1,
  "summary": "Added typed handoff schemas and artifact store to phenix-flow extension",
  "completedPlanSteps": ["step_1", "step_2"],
  "claimedChangedFiles": [
    "config/phenix-pi/pi/extensions/phenix-flow/handoff/schemas.ts",
    "config/phenix-pi/pi/extensions/phenix-flow/handoff/artifact-store.ts"
  ],
  "unresolvedIssues": [],
  "verificationNotes": ["All schemas pass type checking"]
}
```

## On rejection

When the tool rejects the handoff:

1. Read the error message carefully
2. Fix the issue (e.g., add missing claimed files, fix schema errors)
3. Call the tool again with the corrected submission
4. The tool checks correlation each time — use the same identity fields
