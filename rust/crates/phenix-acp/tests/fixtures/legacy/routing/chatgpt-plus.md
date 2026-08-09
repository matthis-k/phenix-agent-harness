# Legacy ChatGPT Plus routing

```phenix-router
id: router.legacy-chatgpt-plus
```

## Routes

| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |
|---|---|---|---|---|---|---|---|
| `scout` | `*` | `pi/openai-codex/gpt-5.6-luna/minimal` | `pi/openai-codex/gpt-5.6-luna/low` | `pi/openai-codex/gpt-5.6-luna/medium` | `pi/openai-codex/gpt-5.6-luna/high` | `pi/openai-codex/gpt-5.6-luna/max` | Fast route |
| `planner` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Planning route |
| `architect` | `*` | `pi/openai-codex/gpt-5.6/minimal` | `pi/openai-codex/gpt-5.6/low` | `pi/openai-codex/gpt-5.6/medium` | `pi/openai-codex/gpt-5.6/high` | `pi/openai-codex/gpt-5.6/max` | Architecture route |
| `implementer` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Code route |
| `tester` | `*` | `pi/openai-codex/gpt-5.6-luna/minimal` | `pi/openai-codex/gpt-5.6-luna/low` | `pi/openai-codex/gpt-5.6-luna/medium` | `pi/openai-codex/gpt-5.6-luna/high` | `pi/openai-codex/gpt-5.6-luna/max` | Testing route |
| `verifier` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Verification route |
| `critic` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Review route |
| `finalizer` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Finalization route |
| `qa-synthesizer` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | QA synthesis route |
| `*` | `*` | `pi/openai-codex/gpt-5.6-terra/minimal` | `pi/openai-codex/gpt-5.6-terra/low` | `pi/openai-codex/gpt-5.6-terra/medium` | `pi/openai-codex/gpt-5.6-terra/high` | `pi/openai-codex/gpt-5.6-terra/max` | Fallback route |
