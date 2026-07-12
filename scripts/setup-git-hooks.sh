#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

git config --local core.hooksPath .githooks
chmod +x \
  .githooks/pre-commit \
  .githooks/pre-push \
  scripts/check.sh \
  scripts/check-files.sh \
  scripts/fix-staged.sh \
  scripts/setup-git-hooks.sh

printf 'Configured core.hooksPath=.githooks for %s\n' "$repo_root"
