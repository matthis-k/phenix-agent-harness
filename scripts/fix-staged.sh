#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

mapfile -d '' -t staged_files < <(
  git diff --cached --name-only --diff-filter=ACMR -z
)

if ((${#staged_files[@]} == 0)); then
  exit 0
fi

partially_staged=()
for file in "${staged_files[@]}"; do
  if ! git diff --quiet -- "$file"; then
    partially_staged+=("$file")
  fi
done

if ((${#partially_staged[@]} > 0)); then
  printf '%s\n' \
    'Cannot safely apply automatic fixes to partially staged files.' \
    'Stage or stash their remaining changes first:' >&2
  printf '  %s\n' "${partially_staged[@]}" >&2
  exit 1
fi

biome_files=()
nix_files=()
shell_files=()

for file in "${staged_files[@]}"; do
  [[ -f "$file" ]] || continue

  case "$file" in
    *.js | *.jsx | *.mjs | *.cjs | *.ts | *.tsx | *.mts | *.cts | *.json | *.jsonc)
      biome_files+=("$file")
      ;;
  esac

  case "$file" in
    *.nix)
      nix_files+=("$file")
      ;;
  esac

  case "$file" in
    *.sh | .githooks/*)
      shell_files+=("$file")
      ;;
  esac
done

if ((${#biome_files[@]} > 0)); then
  biome check \
    --write \
    --no-errors-on-unmatched \
    --files-ignore-unknown=true \
    "${biome_files[@]}"
fi

for file in "${nix_files[@]}"; do
  statix fix "$file"
  nixfmt "$file"
done

if ((${#shell_files[@]} > 0)); then
  shfmt -w -i 2 -ci "${shell_files[@]}"
fi

git add -- "${staged_files[@]}"

exec bash scripts/check.sh staged
