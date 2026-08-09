# Legacy OpenCode Go routing

```phenix-router
id: router.legacy-opencode-go
```

## Routes

| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
|---|---|---|---|---|---|---|---|
| `scout` | `*` | `pi/opencode-go/mimo-v2.5/minimal` | `pi/opencode-go/mimo-v2.5/low` | `pi/opencode-go/mimo-v2.5/medium` | `pi/opencode-go/mimo-v2.5/high` | `pi/opencode-go/mimo-v2.5/max` | Fast route |
| `planner` | `*` | `pi/opencode-go/glm-5.1/minimal` | `pi/opencode-go/glm-5.1/low` | `pi/opencode-go/glm-5.1/medium` | `pi/opencode-go/glm-5.1/high` | `pi/opencode-go/glm-5.1/max` | Planning route |
| `architect` | `*` | `pi/opencode-go/glm-5.2/minimal` | `pi/opencode-go/glm-5.2/low` | `pi/opencode-go/glm-5.2/medium` | `pi/opencode-go/glm-5.2/high` | `pi/opencode-go/glm-5.2/max` | Architecture route |
| `implementer` | `*` | `pi/opencode-go/kimi-k2.7-code/minimal` | `pi/opencode-go/kimi-k2.7-code/low` | `pi/opencode-go/kimi-k2.7-code/medium` | `pi/opencode-go/kimi-k2.7-code/high` | `pi/opencode-go/kimi-k2.7-code/max` | Code route |
| `tester` | `*` | `pi/opencode-go/kimi-k2.6/minimal` | `pi/opencode-go/kimi-k2.6/low` | `pi/opencode-go/kimi-k2.6/medium` | `pi/opencode-go/kimi-k2.6/high` | `pi/opencode-go/kimi-k2.6/max` | Testing route |
| `verifier` | `*` | `pi/opencode-go/qwen3.7-max/minimal` | `pi/opencode-go/qwen3.7-max/low` | `pi/opencode-go/qwen3.7-max/medium` | `pi/opencode-go/qwen3.7-max/high` | `pi/opencode-go/qwen3.7-max/max` | Verification route |
| `critic` | `*` | `pi/opencode-go/qwen3.7-max/minimal` | `pi/opencode-go/qwen3.7-max/low` | `pi/opencode-go/qwen3.7-max/medium` | `pi/opencode-go/qwen3.7-max/high` | `pi/opencode-go/qwen3.7-max/max` | Review route |
| `finalizer` | `*` | `pi/opencode-go/qwen3.7-plus/minimal` | `pi/opencode-go/qwen3.7-plus/low` | `pi/opencode-go/qwen3.7-plus/medium` | `pi/opencode-go/qwen3.7-plus/high` | `pi/opencode-go/qwen3.7-plus/max` | Finalization route |
| `qa-synthesizer` | `*` | `pi/opencode-go/qwen3.7-max/minimal` | `pi/opencode-go/qwen3.7-max/low` | `pi/opencode-go/qwen3.7-max/medium` | `pi/opencode-go/qwen3.7-max/high` | `pi/opencode-go/qwen3.7-max/max` | QA synthesis route |
| `*` | `*` | `pi/opencode-go/qwen3.7-plus/minimal` | `pi/opencode-go/qwen3.7-plus/low` | `pi/opencode-go/qwen3.7-plus/medium` | `pi/opencode-go/qwen3.7-plus/high` | `pi/opencode-go/qwen3.7-plus/max` | Fallback route |
