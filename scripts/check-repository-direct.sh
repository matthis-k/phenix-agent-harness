#!/usr/bin/env bash
set -euo pipefail

if (($# > 1)); then
  printf 'usage: %s [REPOSITORY_ROOT]\n' "$0" >&2
  exit 2
fi

repo_root="${1:-$(git rev-parse --show-toplevel)}"
repo_root="$(cd "$repo_root" && pwd)"

shell_files=()
while IFS= read -r -d '' file; do
  shell_files+=("$file")
done < <(
  find \
    "$repo_root/scripts" \
    "$repo_root/.githooks" \
    -maxdepth 1 \
    -type f \
    \( -name '*.sh' -o -path "$repo_root/.githooks/*" \) \
    -print0 |
    sort -z
)

bash -n "${shell_files[@]}"
shellcheck "${shell_files[@]}"
shfmt -d -i 2 -ci "${shell_files[@]}"

actionlint "$repo_root"/.github/workflows/*.yml
biome ci \
  --config-path "$repo_root/biome.json" \
  --no-errors-on-unmatched \
  --files-ignore-unknown=true \
  "$repo_root/biome.json" \
  "$repo_root/.tend.json"
