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
    in
    {
      packages.phenix-tui = phenixTui;
      packages.phenix = phenix;
      apps.phenix.program = pkgs.lib.getExe phenix;
      checks.phenix-frontend = phenixTui;
    };
}
