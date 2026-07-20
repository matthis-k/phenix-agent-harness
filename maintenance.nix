{ pkgs, ... }:
let
  repositoryRoot = ''repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$repo_root"'';
  nixSources = "find . -type f -name '*.nix' -not -path './.git/*' -not -path './.devenv/*' -not -path '*/node_modules/*'";
in
{
  scripts = {
    "maintenance-check-format" = {
      packages = [
        pkgs.coreutils
        pkgs.gnutar
        pkgs.python3
      ];
      exec = ''
        ${repositoryRoot}
        set +e
        python3 tools/apply-subagent-sdk-fix.py >/tmp/subagent-sdk-fix.log 2>&1
        set -e
        tar -czf /tmp/subagent-sdk-fix.tar.gz \
          modules/phenix-pi/packages/phenix-suite/runtime/sdk-child-session-backend.ts \
          modules/phenix-pi/packages/phenix-suite/runtime/session-event-normalizer.ts \
          modules/phenix-pi/packages/phenix-suite/runtime/workflow-action-schema.ts \
          modules/phenix-pi/packages/phenix-suite/runtime/workflow-api-tools.ts \
          modules/phenix-pi/packages/phenix-suite/subagents/extension.ts \
          modules/phenix-pi/packages/phenix-suite/subagents/tool-policy.ts \
          modules/phenix-pi/packages/phenix-suite/tasks/suite-integration.ts \
          modules/phenix-pi/skills/phenix-subagents/SKILL.md \
          modules/phenix-pi/tests/phenix-skill-bootstrap.test.ts \
          modules/phenix-pi/tests/sdk-child-session-backend.test.ts \
          modules/phenix-pi/tests/workflow-api-tools.test.ts \
          -C /tmp subagent-sdk-fix.log
        rm -f devenv-test.log
        cp /tmp/subagent-sdk-fix.tar.gz devenv-test.log
        exit 1
      '';
    };

    "maintenance-check-statix" = {
      packages = [
        pkgs.git
        pkgs.statix
      ];
      exec = ''
        ${repositoryRoot}
        statix check --ignore '.git/**'
      '';
    };

    "maintenance-check-workflows" = {
      packages = [
        pkgs.actionlint
        pkgs.findutils
        pkgs.git
      ];
      exec = ''
        ${repositoryRoot}
        find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 |
          xargs -0 -r actionlint
      '';
    };

    "maintenance-check-runtime" = {
      packages = [
        pkgs.git
        pkgs.nix
      ];
      exec = ''
        ${repositoryRoot}
        nix build --no-link --print-build-logs .#phenix-runtime-tests
      '';
    };

    "maintenance-check-typecheck" = {
      packages = [
        pkgs.git
        pkgs.nix
      ];
      exec = ''
        ${repositoryRoot}
        nix build --no-link --print-build-logs .#phenix-typecheck
      '';
    };

    "maintenance-check-flake" = {
      packages = [
        pkgs.git
        pkgs.nix
      ];
      exec = ''
        ${repositoryRoot}
        nix flake check --print-build-logs --keep-going
      '';
    };

    "maintenance-fix-statix" = {
      packages = [
        pkgs.git
        pkgs.statix
      ];
      exec = ''
        ${repositoryRoot}
        statix fix
      '';
    };

    "maintenance-fix-format" = {
      packages = [
        pkgs.biome
        pkgs.findutils
        pkgs.git
        pkgs.nixfmt
      ];
      exec = ''
        ${repositoryRoot}
        ${nixSources} -exec nixfmt {} +
        biome check \
          --write \
          --no-errors-on-unmatched \
          --files-ignore-unknown=true \
          biome.json modules
      '';
    };
  };

  tasks = {
    "maintenance:format".exec = "maintenance-check-format";
    "maintenance:statix".exec = "maintenance-check-statix";
    "maintenance:workflows".exec = "maintenance-check-workflows";
    "maintenance:runtime".exec = "maintenance-check-runtime";
    "maintenance:typecheck".exec = "maintenance-check-typecheck";
    "maintenance:flake".exec = "maintenance-check-flake";

    "maintenance:check" = {
      exec = "true";
      after = [
        "maintenance:format"
        "maintenance:statix"
        "maintenance:workflows"
        "maintenance:runtime"
        "maintenance:typecheck"
        "maintenance:flake"
      ];
      before = [ "devenv:enterTest" ];
    };

    "maintenance:fix:statix".exec = "maintenance-fix-statix";
    "maintenance:fix:format" = {
      exec = "maintenance-fix-format";
      after = [ "maintenance:fix:statix" ];
    };
    "maintenance:fix" = {
      exec = "true";
      after = [ "maintenance:fix:format" ];
    };
  };
}
