---
name: phenix-d1-noscout
description: Bounded Phenix workflow with plan, implement, verify (no scout)
---

## phenix-planner

phase: Planning
label: Produce plan
as: plan
output: phenix-plan.json
contract: phenix-flow:plan
model: opencode-go/qwen3.7-plus
thinking: medium

Create a concrete implementation plan.

## phenix-worker

phase: Implementation
label: Implement plan
as: patch
output: phenix-patch.json
contract: phenix-flow:patch
model: opencode-go/kimi-k2.7-code
thinking: low

Implement the plan. Make minimal focused changes.

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

Plan: {outputs.plan}
Patch: {outputs.patch}
