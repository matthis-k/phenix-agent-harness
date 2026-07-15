---
name: phenix-subagents
description: Use the deterministic Phenix workflow and contract-owned isolated subagents.
disable-model-invocation: true
---

# Phenix subagents

Phenix workflow states, legal transitions, configured-agent availability,
delegation depth, role authority, output schemas, model routing, verification,
critics, and repair limits are owned by the TypeScript runtime.

Use only the delegation transitions projected into the current system prompt.
Call `phenix_create_subagent` with the exact transition ID and workflow revision shown
there. Do not invent roles or transitions.

Each accepted child must finish through `phenix_complete`.
