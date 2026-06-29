<!-- Phenix glossary — available to all agents via opencode config knowledge. -->
# Phenix glossary

## Phenix commit terminology

When the user asks for a **local commit**, commit only the current node/repository. Do not push. Do not walk the DAG. Do not update downstream flake inputs unless explicitly requested.

When the user asks for a **commit**, commit the current node/repository and push it. This is a single-node operation. Do not walk the DAG and do not update downstream consumers.

When the user asks for a **sync commit**, **commit sync**, **synced commit**, or just **sync** in a commit context, perform the DAG-aware commit operation: compute the affected DAG, walk it dependency-first, update downstream flake inputs where required, commit each affected node, and push each affected node.

Alias rules:

- `commit locally` = `local commit`
- `local commit` = commit current node only, no push
- `commit` = commit current node and push
- `commit and push` = `commit`
- `sync commit` = `synced commit`
- `commit sync` = `synced commit`
- `synced commit` = DAG-aware commit with flake input propagation and push
- `sync` in a commit/finalization context = `synced commit`

If the user's wording is ambiguous, prefer the safest narrower interpretation:
single-node `commit` rather than DAG-wide `synced commit`, unless the user mentions sync, DAG, flake input propagation, downstream consumers, or multiple Phenix nodes.

- **Affected DAG**: The selected nodes plus dependency-graph neighbors that must
  be checked because a change can affect them.
- **Provider**: A lower-layer repo that exports pins, packages, tools, or shared
  contracts consumed by other repos.
- **Consumer**: A higher-layer repo that depends on providers to compose runtime,
  desktop, host, or workspace behavior.
- **Root workspace**: The top-level `phenix` repo that aggregates active
  subflakes and coordinates verification; it is not a child dependency provider.
- **Retired repo**: A former repo or role kept only for historical notes and not
  included in active topology, root inputs, hooks, or normal verification.
