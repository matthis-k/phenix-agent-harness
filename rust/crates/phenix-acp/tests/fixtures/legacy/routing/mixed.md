# Legacy mixed routing

```phenix-router
id: router.legacy-mixed
```

## Routes

| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `scout` | `*` | `pi/opencode-go/mimo-v2.5` | D1 fast route |
| `planner` | `*` | `pi/openai-codex/gpt-5.6-terra` | D2 reasoning route |
| `architect` | `*` | `pi/openai-codex/gpt-5.6` | D2 reasoning-max route |
| `implementer` | `*` | `pi/opencode-go/kimi-k2.7-code` | D1 code route |
| `tester` | `*` | `pi/opencode-go/kimi-k2.6` | D1 code-fast route |
| `verifier` | `*` | `pi/openai-codex/gpt-5.6-terra` | D2 review route |
| `critic` | `*` | `pi/openai-codex/gpt-5.6-terra` | D2 review route |
| `finalizer` | `*` | `pi/opencode-go/qwen3.7-plus` | D1 general route |
| `qa-synthesizer` | `*` | `pi/openai-codex/gpt-5.6-terra` | D2 review route |
| `*` | `*` | `pi/opencode-go/qwen3.7-plus` | D1 base fallback route |
