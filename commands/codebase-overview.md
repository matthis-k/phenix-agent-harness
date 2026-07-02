---
description: Get a cheap architecture/codebase overview through codebase-memory MCP
agent: phenix-architect
subtask: true
---

Use codebase_memory tools to produce a compact overview of this repository.

Focus on:

- languages
- entry points
- major modules
- dependency direction
- architecture boundaries
- hotspots
- likely test/build/config roots
- risks for future agent work

Do not edit files.

Return:

```yaml
status: summarized
codebase_memory:
  used: true
summary:
languages:
  - language:
entry_points:
  - path:
modules:
  - name:
    files:
    purpose:
dependency_direction:
  notes:
hotspots:
  - item:
risks:
  - risk:
```
