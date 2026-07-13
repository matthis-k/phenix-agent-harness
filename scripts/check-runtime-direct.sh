#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

mode="${1:-}"
pi_root="${PHENIX_PI_ROOT:-$repo_root/modules/phenix-pi}"

if [[ ! -d "$pi_root" ]]; then
  printf 'Phenix Pi root does not exist: %s\n' "$pi_root" >&2
  exit 1
fi

if [[ ! -d "$pi_root/node_modules" ]]; then
  printf 'Phenix Pi dependencies are missing at %s/node_modules\n' "$pi_root" >&2
  printf 'Run this check through the Nix-provided Tend gate.\n' >&2
  exit 1
fi

case "$mode" in
  runtime-tests)
    cd "$pi_root"
    node --experimental-strip-types --test tests/*.test.ts
    node --check runtime/verify.mjs
    ;;
  typecheck)
    exec tsc --project "$pi_root/tsconfig.json" --pretty false
    ;;
  *)
    printf 'usage: %s [runtime-tests|typecheck]\n' "$0" >&2
    exit 2
    ;;
esac
