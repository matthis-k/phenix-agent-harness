# Capability and budget routing

```phenix-router
id: phenix.capability-budget
```

## Routes

| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `planner` | `*` | `pi/phenix/chatgpt-plus` | Prefer the stronger planning route |
| `verifier` | `*` | `pi/phenix/chatgpt-plus` | Prefer the stronger verification route |
| `*` | `*` | `pi/phenix/mixed` | Use the standard mixed route |
