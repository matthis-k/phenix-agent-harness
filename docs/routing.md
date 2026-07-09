---
title: routing
type: note
permalink: newxos/routing
---

# Phenix Agent Model Config

Phenix agent model selection is static OpenCode configuration.

There is no `phenix-route` command, no Rust routing module, no generated routing
overlay, and no routing MCP server. OpenCode receives concrete model assignments
through `agent.<name>.model` in the generated OpenCode config.

## Static launcher profiles

The harness exposes separate static launcher/config package variants named
`go`, `gpt`, `mixed`, and `free`. Each variant is built by Nix and writes
concrete `agent.<name>.model` strings into the generated OpenCode config before
OpenCode starts:

- `opencode-gpt` / `generated-config-gpt`: all workflow agents use GPT through
  OpenCode auth. This is also the default `opencode` package and preserves the
  current all-GPT behavior.
- `opencode-go` / `generated-config-go`: workflow agents use OpenCode Go model
  IDs.
- `opencode-mixed` / `generated-config-mixed`: GPT-family planning and
  verification with an OpenCode Go worker.
- `opencode-free` / `generated-config-free`: free OpenCode model IDs via the
  Zen API (`opencode` provider). Use only for public, low-risk work; Phenix
  policy still denies free-model routing for private, secret, security-sensitive,
  D2/D3, commit, sync, push, or main-bound work.

The default GPT profile currently emits:

```json
{
  "agent": {
    "phenix-workflow": { "model": "openai/gpt-5.5" },
    "phenix-planner": { "model": "openai/gpt-5.5" },
    "phenix-architect": { "model": "openai/gpt-5.5" },
    "phenix-worker": { "model": "openai/gpt-5.5" },
    "phenix-verifier": { "model": "openai/gpt-5.5" },
    "phenix-architecture-verifier": { "model": "openai/gpt-5.5" },
    "phenix-commit-sync": { "model": "openai/gpt-5.5" },
    "failure-analyzer": { "model": "openai/gpt-5.5" },
    "uiux-designer": { "model": "openai/gpt-5.5" }
  }
}
```

## Boundary

Valid:

```text
modules/package.nix settings.agent.<name>.model
  -> generated OpenCode config
  -> OpenCode loads config
```

Invalid:

```text
Rust resolves routing modes
MCP server selects models
Wrapper shell mutates model config from route state
Unknown custom top-level OpenCode keys such as phenix_agent_routing
```

The large `phenix_agent_routing` YAML policy is useful design material, but it is
not valid as a top-level OpenCode config key. OpenCode validates config strictly,
so Phenix stores only schema-valid OpenCode model fields in generated config.

Changing profile means launching a different Nix package/config variant and then
restarting OpenCode. Runtime hot-swap is not supported.