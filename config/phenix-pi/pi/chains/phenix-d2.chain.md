---
name: phenix-d2
description: Multi-file or architectural Phenix workflow with scout, plan, critic, implement, verify
---

## phenix-scout

phase: Context
label: Gather repo evidence
as: context
output: phenix-context.json
outputMode: file-only
contract: phenix-flow:context
model: opencode-go/deepseek-v4-flash
thinking: medium

Scout the repository and return compact structured context.

## phenix-planner

phase: Planning
label: Plan architecture-aware change
as: plan
output: phenix-plan.json
contract: phenix-flow:plan
model: opencode-go/glm-5.1
thinking: high

Create a concrete plan using scout evidence.

Scout output: {outputs.context}

## phenix-reviewer

phase: Review
label: Critique plan before implementation
as: plan-review
output: phenix-plan-review.json
contract: phenix-flow:plan-review
model: opencode-go/deepseek-v4-pro
thinking: medium

Review the plan. Focus on hidden complexity, missing tests, architectural drift, and scope creep.

Context: {outputs.context}
Plan: {outputs.plan}

## phenix-worker

phase: Implementation
label: Implement reviewed plan
as: patch
output: phenix-patch.json
contract: phenix-flow:patch
model: opencode-go/kimi-k2.7-code
thinking: medium

Implement the plan, accounting for review feedback.

Context: {outputs.context}
Plan: {outputs.plan}
Review: {outputs.plan-review}

## phenix-verifier

phase: Verification
label: Verify result
as: verification
output: phenix-verification.json
contract: phenix-flow:verification
model: opencode-go/glm-5.1
thinking: high

Verify the result against requirements, plan, and review.

Context: {outputs.context}
Plan: {outputs.plan}
Review: {outputs.plan-review}
Patch: {outputs.patch}
