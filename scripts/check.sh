#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

mode="${1:-full}"

case "$mode" in
  staged)
    git diff --cached --check
    mapfile -d '' -t files < <(
      git diff --cached --name-only --diff-filter=ACMR -z
    )
    bash scripts/check-files.sh "${files[@]}"
    ;;
  range)
    if (($# != 3)); then
      printf 'usage: %s range BASE HEAD\n' "$0" >&2
      exit 2
    fi
    base="$2"
    head="$3"
    git diff --check "$base" "$head"
    mapfile -d '' -t files < <(
      git diff --name-only --diff-filter=ACMR -z "$base" "$head"
    )
    bash scripts/check-files.sh "${files[@]}"
    ;;
  full)
    git diff --check
    nix flake check --print-build-logs --keep-going
    ;;
  *)
    printf 'usage: %s [staged|range BASE HEAD|full]\n' "$0" >&2
    exit 2
    ;;
esac
