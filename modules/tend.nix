{ inputs, lib, ... }:

{
  perSystem =
    {
      pkgs,
      self',
      system,
      ...
    }:
    let
      tooling = import ./tooling.nix { inherit pkgs; };
      tendCli = inputs.phenix-tend.packages.${system}.tend-unwrapped;
      phenixPiPackage = self'.packages.phenix-pi-package;

      phenixTend = pkgs.writeShellApplication {
        name = "tend";
        runtimeInputs = tooling.tendRuntime;
        text = ''
          if repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
            root="$repo_root"
          else
            root="$PWD"
          fi

          exec ${tendCli}/bin/tend --root "$root" "$@"
        '';
      };

      source = lib.cleanSource ../.;

      tendNixCheck =
        pkgs.runCommand "phenix-tend-nix-check"
          {
            nativeBuildInputs = [
              phenixTend
              pkgs.git
            ];
            inherit source;
          }
          ''
            cp -rT "$source" source
            chmod -R u+w source

            rm -rf source/modules/phenix-pi/node_modules
            ln -s ${phenixPiPackage}/node_modules source/modules/phenix-pi/node_modules

            cd source
            git init --quiet
            git add -A

            export HOME="$TMPDIR/home"
            export PHENIX_PI_ROOT="$PWD/modules/phenix-pi"
            mkdir -p "$HOME"

            tend check --profile full --context nix-sandbox

            touch "$out"
          '';
    in
    {
      packages.tend = phenixTend;

      apps.tend = {
        type = "app";
        program = "${phenixTend}/bin/tend";
      };

      checks.tend-nix-check = tendNixCheck;

      devShells.default = pkgs.mkShell {
        name = "phenix-agent-harness-dev";
        packages =
          tooling.agentRuntime
          ++ tooling.quality
          ++ [
            phenixTend
            self'.packages.stitch
            self'.packages.stitch-mcp
            self'.packages.setup-git-hooks
            self'.packages.update-pi-npm-lock
          ];

        shellHook = ''
          echo "phenix-agent-harness dev shell"
          echo "  tend check --profile manual --context local"
          echo "  tend check --profile pre-push --context local"
          echo "  tend check --profile fix --context local"
          echo "  stitch workspace discover --json"
          echo "  stitch verify --changed --profile manual --context local"
        '';
      };
    };
}
