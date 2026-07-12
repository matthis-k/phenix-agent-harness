#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if (($# == 0)); then
  exit 0
fi

biome_files=()
nix_files=()
shell_files=()
workflow_files=()

for file in "$@"; do
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

  case "$file" in
    .github/workflows/*.yml | .github/workflows/*.yaml)
      workflow_files+=("$file")
      ;;
  esac
done

status=0

if ((${#biome_files[@]} > 0)); then
  biome ci \
    --no-errors-on-unmatched \
    --files-ignore-unknown=true \
    --error-on-warnings \
    "${biome_files[@]}" || status=1
fi

for file in "${nix_files[@]}"; do
  temporary_directory="$(mktemp -d)"
  temporary_file="$temporary_directory/$(basename "$file")"
  cp -- "$file" "$temporary_file"

  if nixfmt "$temporary_file"; then
    if ! cmp -s -- "$file" "$temporary_file"; then
      printf 'Nix formatting differs: %s\n' "$file" >&2
      diff -u -- "$file" "$temporary_file" || true
      status=1
    fi
  else
    status=1
  fi

  rm -rf -- "$temporary_directory"
  statix check "$file" || status=1
done

for file in "${shell_files[@]}"; do
  shfmt -d -i 2 -ci "$file" || status=1
  bash -n "$file" || status=1
  shellcheck "$file" || status=1
done

for file in "${workflow_files[@]}"; do
  actionlint "$file" || status=1
done

exit "$status"
