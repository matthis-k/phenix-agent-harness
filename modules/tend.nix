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
      tendCli = inputs.phenix-tend.packages.${system}.tend;
      phenixPiPackage = self'.packages.phenix-pi-package;

      tendRuntimeInputs = [ tendCli ] ++ tooling.tendRuntime;

      phenixTend = pkgs.writeShellApplication {
        name = "tend";
        runtimeInputs = tendRuntimeInputs;
        text = ''
          if repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
            root="$repo_root"
          else
            root="$PWD"
          fi

          exec "${tendCli}/bin/tend" --root "$root" "$@"
        '';
      };

      source = lib.cleanSource ../.;

      tendProfileValidation = pkgs.runCommand "phenix-tend-profile-validation" {
        nativeBuildInputs = [
          tendCli
          pkgs.git
        ];
        inherit source;
      } ''
        cp -rT "$source" source
        chmod -R u+w source
        cd source

        git init --quiet
        git add -A
        tend validate --profiles

        touch "$out"
      '';

      tendNixCheck = pkgs.runCommand "phenix-tend-nix-check" {
        nativeBuildInputs = tendRuntimeInputs;
        inherit source;
      } ''
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

        tend run --mode full --phase verify --profile nix-check

        touch "$out"
      '';
    in
    {
      packages = {
        tend = phenixTend;
        tend-cli = tendCli;
      };

      apps.tend = {
        type = "app";
        program = "${phenixTend}/bin/tend";
      };

      checks = {
        tend-profile-validation = tendProfileValidation;
        tend-nix-check = tendNixCheck;
      };

      devShells.default = pkgs.mkShell {
        name = "phenix-agent-harness-dev";
        packages = lib.unique (
          tooling.agentRuntime
          ++ tooling.quality
          ++ [
            phenixTend
            self'.packages.setup-git-hooks
            self'.packages.update-pi-npm-lock
          ]
        );

        shellHook = ''
          echo "phenix-agent-harness dev shell"
          echo "  tend check --profile manual"
          echo "  tend check --profile pre-push"
          echo "  tend check --profile fix --staged"
        '';
      };
    };
}
