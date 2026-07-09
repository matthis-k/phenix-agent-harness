---
title: routing
type: note
permalink: newxos/routing
---

# Phenix Agent Model Routing

Phenix uses a **provider-first** model router at runtime — model selection IS
the routing. Selecting `phenix/free` routes to `opencode/deepseek-v4-flash-free`.
Selecting `phenix/opencode-go` routes to `opencode/deepseek-v4-flash`.

There is no separate "routing mode" state, no retry/evidence artifact, no
`routing-config.yaml` parsing at runtime, and no generated overlay.

## How it works

### 1. Phenix provider (`phenix-router.ts`)

The Pi extension registers a `phenix` provider with 5 frontend model IDs:
`auto`, `free`, `mixed`, `opencode-go`, `gpt`. Each maps to a concrete
backend model slot (planner, worker, verifier). The `routerStream` function
resolves the frontend ID → concrete model, fetches API auth, and delegates
to the real model provider.

```
phenix/free        → opencode/deepseek-v4-flash-free
phenix/opencode-go → opencode/deepseek-v4-flash
```

Override slots via `phenix-router.routes.json` in `~/.pi/extensions/` or
project `.pi/` — only `slots` entries, no `mode` field.

### 2. Routing matrix (`phenix-routing-matrix.ts`)

A callable TypeScript module encoding the full routing policy from
the former `routing-config.yaml`. Agents import it directly — no YAML
parsing needed.

```typescript
import { classifyAndRoute, resolveRouting } from "./phenix-routing-matrix";

// One-shot: classify prompt + resolve routing
const result = classifyAndRoute(userPrompt, "free");
// result = { allowed, roles, warnings, modelRef, frontendModelSet }

// Or resolve with explicit params
const result = resolveRouting({
  difficulty: "D2",
  secrecy: "public",
  changeKind: "nix",
  frontendModel: "free",
  targetState: "dev-wallet",
});
```

The matrix applies policy denials (free/auto denied for private/secret and
security-sensitive change kinds), assigns roles per difficulty (D0–D3), and
warns on target state violations.

### 3. `/router` command

- `/router status` — current route + matrix resolution
- `/router routes` — list all available frontend→backend mappings
- `/router explain <prompt>` — classify a prompt and show full matrix output
- `/router reload` — reload routes.json overrides
- `/router reset` — reset to default mappings

## Frontend → concrete model defaults

| Frontend      | Worker                          | Planner                     | Verifier                     |
|---------------|---------------------------------|-----------------------------|------------------------------|
| `auto`        | `opencode/deepseek-v4-flash-free` | (same)                      | (same)                       |
| `free`        | `opencode/deepseek-v4-flash-free` | (same)                      | (same)                       |
| `mixed`       | `opencode/deepseek-v4-flash-free` | `openai/gpt-5.5`            | `openai/gpt-5.5`             |
| `opencode-go` | `opencode/deepseek-v4-flash`      | (same)                      | (same)                       |
| `gpt`         | `openai/gpt-5.5`                  | (same)                      | (same)                       |

## Subagent model resolution

Subagents (`repo_scout`) use the same frontend→model mapping but resolve
through `resolveRoleModel(frontendMode, role, difficulty)` instead of the
full provider router. This keeps model selection in the routing layer
without coupling subagent execution to the parent's model registry.

### `resolveRoleModel`

```typescript
resolveRoleModel("phenix/free", "scout", "D1")
// → "opencode/deepseek-v4-flash-free"

resolveRoleModel("phenix/opencode-go", "worker", "D1")
// → "opencode/deepseek-v4-flash"

resolveRoleModel("phenix/mixed", "verifier", "D2")
// → "openai/gpt-5.5"
```

Model mapping is in `DEFAULT_SUBAGENT_MODELS` in `phenix-subagent-executor.ts`,
not duplicated in workflow logic. Update model config in one place.

### Subagent model overrides

The `RunPhenixSubagentInput.model` field allows explicit model specification.
If set, it bypasses `resolveRoleModel()` and passes the provided model string
directly to the child `pi --model` flag.

### Security

Free-tier subagents (`phenix/free`) are denied for private/secret work by
the routing matrix. The subagent executor does not enforce this itself —
the workflow's routing check runs before the subagent is spawned.

## Boundary

Valid:

```text
Pi settings defaultProvider/providers
  → Pi selects provider/model
  → phenix-router resolves to concrete backend
  → agent runs with concrete model
  → subagent resolves role model (resolveRoleModel)
  → child pi process spawns with resolved model
```

Invalid:

```text
Separate routing mode state tracked alongside model selection
Retry/evidence collection artifacts (FailureEvidence, maxFollowUpRetries)
Rust routing module or MCP routing server
Wrapper shell mutating model config from route state
```

## `routing-config.yaml`

Still present as a **design artifact** and documentation reference. The runtime
logic lives in `phenix-routing-matrix.ts`. To understand the routing policy
without reading TypeScript, look at the YAML — but for programmatic access,
call the TypeScript module.

## Customization

To change model mappings without modifying the extension source, create
`~/.pi/extensions/phenix-router.routes.json`:

```json
{
  "slots": {
    "free": {
      "planner": { "provider": "opencode", "model": "deepseek-v4-flash" },
      "worker": { "provider": "opencode", "model": "deepseek-v4-flash" },
      "verifier": { "provider": "opencode", "model": "deepseek-v4-flash" }
    }
  }
}
```

Project-level overrides (trusted repos only) go in `.pi/phenix-router.routes.json`.
