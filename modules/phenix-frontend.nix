{ ... }:

{
  perSystem =
    { config, pkgs, ... }:
    let
      phenixTui = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-tui";
        version = "0";
        src = pkgs.lib.cleanSource ../rust;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-tui"
        ];
        cargoTestFlags = [
          "--package"
          "phenix-tui"
        ];

        nativeBuildInputs = [
          pkgs.clippy
          pkgs.rustfmt
        ];

        preBuild = ''
          cargo fmt --all --check
          cargo clippy --workspace --all-targets --locked --offline -- -D warnings
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          cp target/release/phenix "$out/bin/phenix"
          runHook postInstall
        '';
      };

      phenix = pkgs.writeShellApplication {
        name = "phenix";
        runtimeInputs = [ pkgs.nodejs ];
        text = ''
          export PHENIX_HEADLESS_PROGRAM="${pkgs.nodejs}/bin/node"
          export PHENIX_HEADLESS_ENTRY="${config.packages.phenix-pi}/headless/main.ts"
          export PHENIX_SOURCE_ROOT="${config.packages.phenix-pi}"
          exec "${phenixTui}/bin/phenix" "$@"
        '';
      };

      phenixSmoke = pkgs.runCommand "phenix-frontend-smoke"
        {
          nativeBuildInputs = [ phenix ];
        }
        ''
          export HOME="$TMPDIR/home"
          export XDG_CONFIG_HOME="$HOME/.config"
          export XDG_DATA_HOME="$HOME/.local/share"
          export XDG_STATE_HOME="$HOME/.local/state"
          export XDG_CACHE_HOME="$HOME/.cache"
          export PI_SKIP_VERSION_CHECK=1
          mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
          phenix --check
          touch "$out"
        '';
    in
    {
      packages.phenix-tui = phenixTui;
      packages.phenix = phenix;
      packages.default = phenix;

      apps.phenix.program = pkgs.lib.getExe phenix;
      apps.default.program = pkgs.lib.getExe phenix;

      checks.phenix-frontend = phenixSmoke;
    };
}
