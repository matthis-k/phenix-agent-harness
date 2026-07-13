#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# The fix profile operates only on staged files. Its formatter implementation
# rejects partially staged files, applies safe deterministic fixes, and re-stages
# the resulting content before the verification profile runs.
nix run --quiet .#tend -- check \
  --profile fix \
  --context local

exec nix run --quiet .#tend -- check \
  --profile git-hook \
  --context local
