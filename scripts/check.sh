#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

mode="${1:-full}"

case "$mode" in
  staged)
    git diff --cached --check

    if git diff --cached --quiet -- \
      flake.nix flake.lock modules scripts .githooks .github/workflows; then
      exit 0
    fi

    nix build --no-link \
      .#phenix-runtime-tests \
      .#phenix-qa-tests \
      .#phenix-repository-checks
    ;;
  full)
    git diff --check
    nix flake check --print-build-logs
    ;;
  *)
    printf 'usage: %s [staged|full]\n' "$0" >&2
    exit 2
    ;;
esac
