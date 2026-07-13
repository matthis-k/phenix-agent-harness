#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

files=("$@")
if ((${#files[@]} == 0)); then
  exit 0
fi

partially_staged=()
for file in "${files[@]}"; do
  [[ -e "$file" ]] || continue
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

for file in "${files[@]}"; do
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

git add -- "${files[@]}"
exec bash scripts/check-files.sh "${files[@]}"
