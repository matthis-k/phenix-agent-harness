#!/usr/bin/env bash
set -euo pipefail

if (($# > 1)); then
  printf 'usage: %s [REPOSITORY_ROOT]\n' "$0" >&2
  exit 2
fi

repo_root="${1:-$(git rev-parse --show-toplevel)}"
repo_root="$(cd "$repo_root" && pwd)"

shell_files=(
  "$repo_root/scripts/check.sh"
  "$repo_root/scripts/check-files.sh"
  "$repo_root/scripts/check-repository-direct.sh"
  "$repo_root/scripts/check-runtime-direct.sh"
  "$repo_root/scripts/fix-staged.sh"
  "$repo_root/scripts/setup-git-hooks.sh"
  "$repo_root/.githooks/pre-commit"
  "$repo_root/.githooks/pre-push"
)

bash -n "${shell_files[@]}"
shellcheck "${shell_files[@]}"
shfmt -d -i 2 -ci "${shell_files[@]}"

actionlint "$repo_root/.github/workflows/ci.yml"
biome ci \
  --config-path "$repo_root/biome.json" \
  --no-errors-on-unmatched \
  --files-ignore-unknown=true \
  "$repo_root/biome.json" \
  "$repo_root/.tend.json"
