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
          "--workspace"
          "--all-targets"
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

      mkPhenixWrapper =
        {
          name ? "phenix",
          configText ? "-- Configured by Nix. Built-in defaults remain enabled.\n",
          configFile ? null,
          loadDefaults ? true,
          extraArgs ? [ ],
        }:
        let
          frontendConfig =
            if configFile != null then
              configFile
            else
              pkgs.writeText "${name}-init.lua" configText;
          wrapperArguments =
            (pkgs.lib.optional (!loadDefaults) "--no-default-config")
            ++ extraArgs;
        in
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [ pkgs.nodejs ];
          text = ''
            export PHENIX_HEADLESS_PROGRAM="${pkgs.nodejs}/bin/node"
            export PHENIX_HEADLESS_ENTRY="${config.packages.phenix-pi}/headless/main.ts"
            export PHENIX_SOURCE_ROOT="${config.packages.phenix-pi}"
            export PHENIX_CONFIG="${frontendConfig}"
            exec "${phenixTui}/bin/phenix" ${pkgs.lib.escapeShellArgs wrapperArguments} "$@"
          '';
        };

      phenix = mkPhenixWrapper { };

      configuredSmokePackage = mkPhenixWrapper {
        name = "phenix-configured-smoke";
        configText = ''
          phenix.keymap.del("global", "<C-q>")
          phenix.theme.set("Accent", { fg = "#ffffff", bold = true })
          assert(type(phenix.ui.pane.resize) == "function")
        '';
      };

      phenixSmoke = pkgs.runCommand "phenix-frontend-smoke"
        {
          nativeBuildInputs = [
            phenix
            configuredSmokePackage
          ];
        }
        ''
          export HOME="$TMPDIR/home"
          export XDG_CONFIG_HOME="$HOME/.config"
          export XDG_DATA_HOME="$HOME/.local/share"
          export XDG_STATE_HOME="$HOME/.local/state"
          export XDG_CACHE_HOME="$HOME/.cache"
          export PI_SKIP_VERSION_CHECK=1
          mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

          phenix --print-default-config | grep -q 'phenix.layout.set'
          phenix --check
          phenix-configured-smoke --check
          touch "$out"
        '';
    in
    {
      packages.phenix-tui = phenixTui;
      packages.phenix = phenix;
      packages.default = phenix;

      legacyPackages.phenixFrontend = {
        inherit mkPhenixWrapper;
        defaultLua = ../rust/crates/phenix-ui-lua/default.lua;
      };

      apps.phenix.program = pkgs.lib.getExe phenix;
      apps.default.program = pkgs.lib.getExe phenix;

      checks.phenix-frontend = phenixSmoke;
    };
}
