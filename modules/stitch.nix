{ inputs, ... }:

{
  perSystem =
    {
      pkgs,
      system,
      ...
    }:
    let
      upstream = inputs.phenix-stitch.packages.${system};
      mcpConfig = ./phenix-pi/config/mcp.json;

      workspaceEnvironment = ''
        if repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
          workspace_parent="$(dirname "$repo_root")"
        else
          repo_root="$PWD"
          workspace_parent="$(dirname "$PWD")"
        fi

        export STITCH_DISCOVERY_OWNER="''${STITCH_DISCOVERY_OWNER:-matthis-k}"
        export STITCH_DISCOVERY_REPOSITORY_PATTERN="''${STITCH_DISCOVERY_REPOSITORY_PATTERN:-phenix-*}"

        if [[ -z "''${STITCH_DISCOVERY_ROOTS:-}" ]]; then
          discovery_roots=("$workspace_parent")
          if [[ -d "$repo_root/repos" ]]; then
            discovery_roots+=("$repo_root/repos")
          fi
          stitch_discovery_roots="$(IFS=:; printf '%s' "''${discovery_roots[*]}")"
          export STITCH_DISCOVERY_ROOTS="$stitch_discovery_roots"
        fi
      '';

      phenixStitch = pkgs.writeShellApplication {
        name = "stitch";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.git
          upstream.stitch
        ];
        text = ''
          ${workspaceEnvironment}
          exec ${upstream.stitch}/bin/stitch "$@"
        '';
      };

      phenixStitchMcp = pkgs.writeShellApplication {
        name = "stitch-mcp";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.git
          upstream.stitch-mcp
        ];
        text = ''
          ${workspaceEnvironment}
          exec ${upstream.stitch-mcp}/bin/stitch-mcp "$@"
        '';
      };

      stitchRuntimeSmoke =
        pkgs.runCommand "phenix-stitch-runtime-smoke"
          {
            nativeBuildInputs = [
              phenixStitch
              pkgs.git
              pkgs.jq
            ];
          }
          ''
            jq -e '
              .mcpServers.stitch.command == "stitch-mcp" and
              .mcpServers.stitch.lifecycle == "lazy" and
              .settings.directTools == false
            ' ${mcpConfig}

            mkdir source
            cd source
            git init --quiet
            git config user.name "Phenix CI"
            git config user.email "ci@example.invalid"
            touch flake.nix
            git add flake.nix
            git commit --quiet -m init

            stitch --version
            stitch workspace discover \
              --workspace . \
              --repository-pattern 'phenix-*' \
              --json > discovery.json

            jq -e '
              (.repos | length) == 1 and
              .repos[0].path == "."
            ' discovery.json

            touch "$out"
          '';
    in
    {
      packages = {
        stitch = phenixStitch;
        stitch-mcp = phenixStitchMcp;
      };

      apps = {
        stitch = {
          type = "app";
          program = "${phenixStitch}/bin/stitch";
          meta.description = "Coordinate a discovered Phenix multi-repository workspace";
        };
        stitch-mcp = {
          type = "app";
          program = "${phenixStitchMcp}/bin/stitch-mcp";
          meta.description = "Expose Stitch orchestration through MCP";
        };
      };

      checks = {
        stitch-runtime-smoke = stitchRuntimeSmoke;
        stitch-mcp-package = phenixStitchMcp;
      };
    };
}
