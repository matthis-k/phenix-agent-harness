{ pkgs, ... }:
let
  repositoryRoot = ''repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$repo_root"'';
  nixSources = "find . -type f -name '*.nix' -not -path './.git/*' -not -path './.devenv/*'";
in
{
  scripts = {
    "maintenance-check-format" = {
      packages = [
        pkgs.findutils
        pkgs.git
        pkgs.nixfmt
      ];
      exec = ''
        ${repositoryRoot}
        ${nixSources} -exec nixfmt --check {} +
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

    "maintenance-check-tools" = {
      packages = [ pkgs.git ];
      exec = ''
        ${repositoryRoot}
        missing=0
        for executable in bash nix; do
          if ! command -v "$executable" >/dev/null 2>&1; then
            echo "agent tool executable unavailable: $executable was not found in PATH" >&2
            missing=1
          fi
        done
        exit "$missing"
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
        pkgs.findutils
        pkgs.git
        pkgs.nixfmt
      ];
      exec = ''
        ${repositoryRoot}
        ${nixSources} -exec nixfmt {} +
      '';
    };
  };

  tasks = {
    "maintenance:format".exec = "maintenance-check-format";
    "maintenance:statix".exec = "maintenance-check-statix";
    "maintenance:workflows".exec = "maintenance-check-workflows";
    "maintenance:tools".exec = "maintenance-check-tools";
    "maintenance:flake".exec = "maintenance-check-flake";

    "maintenance:check" = {
      exec = "true";
      after = [
        "maintenance:format"
        "maintenance:statix"
        "maintenance:workflows"
        "maintenance:tools"
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
