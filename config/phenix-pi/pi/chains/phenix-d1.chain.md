---
name: phenix-d1
description: Bounded Phenix workflow with scout, plan, implement, verify
---

## phenix-scout

phase: Context
label: Gather local context
as: context
output: phenix-context.json
outputMode: file-only
contract: phenix-flow:context
model: opencode-go/deepseek-v4-flash
thinking: low

Scout the repository and return compact structured context for this task.

## phenix-planner

phase: Planning
label: Produce plan
as: plan
output: phenix-plan.json
contract: phenix-flow:plan
model: opencode-go/qwen3.7-plus
thinking: medium

Create a concrete implementation plan using scout evidence.

Scout output: {outputs.context}

## phenix-worker

phase: Implementation
label: Implement plan
as: patch
output: phenix-patch.json
contract: phenix-flow:patch
model: opencode-go/kimi-k2.7-code
thinking: low

Implement the plan. Make minimal focused changes.

Context: {outputs.context}
Plan: {outputs.plan}

## phenix-verifier

phase: Verification
label: Verify implementation
as: verification
output: phenix-verification.json
contract: phenix-flow:verification
model: opencode-go/deepseek-v4-pro
thinking: medium

Verify the implementation against the plan. Report pass/fail with evidence.

Context: {outputs.context}
Plan: {outputs.plan}
Patch: {outputs.patch}
