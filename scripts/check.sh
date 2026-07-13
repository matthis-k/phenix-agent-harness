#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

mode="${1:-}"

case "$mode" in
  staged)
    git diff --cached --check
    mapfile -d '' -t files < <(
      git diff --cached --name-only --diff-filter=ACMR -z
    )
    bash scripts/check-files.sh "${files[@]}"
    ;;
  ci-range)
    zero_sha="0000000000000000000000000000000000000000"
    head="${TEND_DIFF_HEAD:-HEAD}"
    base="${TEND_DIFF_BASE:-}"

    git cat-file -e "$head^{commit}"

    if [[ -z "$base" || "$base" == "$zero_sha" ]]; then
      if git rev-parse --verify --quiet "$head^" >/dev/null; then
        base="$head^"
      else
        base="$(git hash-object -t tree /dev/null)"
      fi
    else
      git cat-file -e "$base^{commit}"
    fi

    git diff --check "$base" "$head"
    mapfile -d '' -t files < <(
      git diff --name-only --diff-filter=ACMR -z "$base" "$head"
    )
    bash scripts/check-files.sh "${files[@]}"
    ;;
  *)
    printf 'usage: %s {staged|ci-range}\n' "$0" >&2
    exit 2
    ;;
esac
