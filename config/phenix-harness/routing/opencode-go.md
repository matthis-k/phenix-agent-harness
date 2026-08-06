# Legacy OpenCode Go routing

```phenix-router
id: router.legacy-opencode-go
```

## Routes

| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `scout` | `*` | `pi/opencode-go/mimo-v2.5` | D1 fast route |
| `planner` | `*` | `pi/opencode-go/glm-5.1` | D2 reasoning route |
| `architect` | `*` | `pi/opencode-go/glm-5.2` | D2 reasoning-max route |
| `implementer` | `*` | `pi/opencode-go/kimi-k2.7-code` | D1 code route |
| `tester` | `*` | `pi/opencode-go/kimi-k2.6` | D1 code-fast route |
| `verifier` | `*` | `pi/opencode-go/qwen3.7-max` | D2 review route |
| `critic` | `*` | `pi/opencode-go/qwen3.7-max` | D2 review route |
| `finalizer` | `*` | `pi/opencode-go/qwen3.7-plus` | D1 general route |
| `qa-synthesizer` | `*` | `pi/opencode-go/qwen3.7-max` | D2 review route |
| `*` | `*` | `pi/opencode-go/qwen3.7-plus` | D1 base fallback route |
