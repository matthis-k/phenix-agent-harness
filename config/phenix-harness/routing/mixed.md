# Legacy mixed routing

```phenix-router
id: router.legacy-mixed
```

## Routes

| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
|---|---|---|---|---|---|---|---|
| `scout` | `*` | `pi/opencode-go/mimo-v2.5/minimal` | `pi/opencode-go/mimo-v2.5/low` | `pi/opencode-go/mimo-v2.5/medium` | `pi/opencode-go/mimo-v2.5/high` | `pi/opencode-go/mimo-v2.5/max` | Fast route |
| `planner` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Planning route |
| `architect` | `*` | `pi/openai-codex/gpt-5.6/minimal` | `pi/openai-codex/gpt-5.6/low` | `pi/openai-codex/gpt-5.6/medium` | `pi/openai-codex/gpt-5.6/high` | `pi/openai-codex/gpt-5.6/max` | Architecture route |
| `implementer` | `*` | `pi/opencode-go/kimi-k2.7-code/minimal` | `pi/opencode-go/kimi-k2.7-code/low` | `pi/opencode-go/kimi-k2.7-code/medium` | `pi/opencode-go/kimi-k2.7-code/high` | `pi/opencode-go/kimi-k2.7-code/max` | Code route |
| `tester` | `*` | `pi/opencode-go/kimi-k2.6/minimal` | `pi/opencode-go/kimi-k2.6/low` | `pi/opencode-go/kimi-k2.6/medium` | `pi/opencode-go/kimi-k2.6/high` | `pi/opencode-go/kimi-k2.6/max` | Testing route |
| `verifier` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Verification route |
| `critic` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Review route |
| `finalizer` | `*` | `pi/opencode-go/qwen3.7-plus/minimal` | `pi/opencode-go/qwen3.7-plus/low` | `pi/opencode-go/qwen3.7-plus/medium` | `pi/opencode-go/qwen3.7-plus/high` | `pi/opencode-go/qwen3.7-plus/max` | Finalization route |
| `qa-synthesizer` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | QA synthesis route |
| `*` | `*` | `pi/opencode-go/qwen3.7-plus/minimal` | `pi/opencode-go/qwen3.7-plus/low` | `pi/opencode-go/qwen3.7-plus/medium` | `pi/opencode-go/qwen3.7-plus/high` | `pi/opencode-go/qwen3.7-plus/max` | Fallback route |
