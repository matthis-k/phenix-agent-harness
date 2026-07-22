{ pkgs, ... }:
let
  repositoryRoot = ''repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$repo_root"'';
  nixSources = "find . -type f -name '*.nix' -not -path './.git/*' -not -path './.devenv/*' -not -path '*/node_modules/*'";
in
{
  scripts = {
    "maintenance-check-format" = {
      packages = [
        pkgs.biome
        pkgs.findutils
        pkgs.git
        pkgs.nixfmt
      ];
      exec = ''
        ${repositoryRoot}
        ${nixSources} -exec nixfmt --check {} +
        biome ci \
          --config-path biome.json \
          --no-errors-on-unmatched \
          --files-ignore-unknown=true \
          --error-on-warnings \
          biome.json modules
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
      packages = [ pkgs.git ];
      exec = ''
        ${repositoryRoot}
        nix build --no-link --print-build-logs .#phenix-runtime-tests
      '';
    };

    "maintenance-check-typecheck" = {
      packages = [ pkgs.git ];
      exec = ''
        ${repositoryRoot}
        nix build --no-link --print-build-logs .#phenix-typecheck
      '';
    };

    "maintenance-check-flake" = {
      packages = [ pkgs.git ];
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
