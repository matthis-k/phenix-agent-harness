# Legacy ChatGPT Plus routing

```phenix-router
id: router.legacy-chatgpt-plus
```

## Routes

| Role | Workflow | Target | Explanation |
|---|---|---|---|
| `scout` | `*` | `pi/openai-codex/gpt-5.6-luna` | D1 fast route |
| `planner` | `*` | `pi/openai-codex/gpt-5.6-terra` | D2 reasoning route |
| `architect` | `*` | `pi/openai-codex/gpt-5.6` | D2 reasoning-max route |
| `implementer` | `*` | `pi/openai-codex/gpt-5.6-terra` | D1 code route |
| `tester` | `*` | `pi/openai-codex/gpt-5.6-luna` | D1 code-fast route |
| `verifier` | `*` | `pi/openai-codex/gpt-5.6-terra` | D2 review route |
| `critic` | `*` | `pi/openai-codex/gpt-5.6-terra` | D2 review route |
| `finalizer` | `*` | `pi/openai-codex/gpt-5.6-terra` | D1 general route |
| `qa-synthesizer` | `*` | `pi/openai-codex/gpt-5.6-terra` | D2 review route |
| `*` | `*` | `pi/openai-codex/gpt-5.6-terra` | D1 base fallback route |
