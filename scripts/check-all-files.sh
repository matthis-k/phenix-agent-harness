#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

mapfile -d '' -t files < <(
  git ls-files --cached --others --exclude-standard -z
)

if ((${#files[@]} == 0)); then
  exit 0
fi

exec bash scripts/check-files.sh "${files[@]}"
