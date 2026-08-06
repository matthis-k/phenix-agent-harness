# Legacy compatibility fixtures

These fixtures project the legacy Pi workflow catalog into the current static Phenix ACP session-tree definition format.

They intentionally preserve the legacy workflow IDs, delegated roles, delegation order, objective intent, and the default routing outcomes used by each legacy model set. The current format does not yet represent the old state-machine-only behavior such as local states, decisions, joins, retries, difficulty-dependent branches, candidate fallback pools, or nested workflow invocation. The fixtures therefore test the compatible semantic subset instead of claiming full state-machine equivalence.

The routing fixtures are the default-difficulty, first-candidate projections of the former `free`, `opencode-go`, `chatgpt-plus`, and `mixed` model sets. All targets are backend-qualified as `pi/provider/model` because the legacy runtime was owned by the Pi backend.

Run the permanent compatibility suite with:

```console
cargo test --package phenix-acp --test legacy_definitions
```
