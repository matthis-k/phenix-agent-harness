#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

git config --local core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push

printf 'Configured core.hooksPath=.githooks for %s\n' "$repo_root"
