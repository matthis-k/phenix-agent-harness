_:

{
  perSystem =
    { config, pkgs, ... }:
    let
      rustSource = pkgs.lib.cleanSource ../rust;

      phenixTui = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-tui";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-tui"
        ];
        cargoTestFlags = [
          "--package"
          "phenix-tui"
        ];

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          phenix_binary="$(find target -path '*/release/phenix' -type f -print -quit)"
          test -n "$phenix_binary"
          cp "$phenix_binary" "$out/bin/phenix"
          runHook postInstall
        '';
      };

      phenixAcpSmoke = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-acp-smoke";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-acp-presets"
          "--bin"
          "phenix-acp-smoke"
        ];
        cargoTestFlags = [
          "--package"
          "phenix-acp-presets"
        ];

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          smoke_binary="$(find target -path '*/release/phenix-acp-smoke' -type f -print -quit)"
          test -n "$smoke_binary"
          cp "$smoke_binary" "$out/bin/phenix-acp-smoke"
          runHook postInstall
        '';
      };

      mkPhenixWrapper =
        {
          name ? "phenix",
          configText ? null,
          configFile ? null,
          acpConfigDir ? ../config/phenix-acp,
          loadDefaults ? true,
          extraArgs ? [ ],
        }:
        let
          frontendConfig =
            if configFile != null then
              configFile
            else if configText != null then
              pkgs.writeText "${name}-init.lua" configText
            else
              null;
          configExport = pkgs.lib.optionalString (frontendConfig != null) ''
            export PHENIX_CONFIG="${frontendConfig}"
          '';
          wrapperArguments =
            [
              "--phenix-acp-config"
              (toString acpConfigDir)
            ]
            ++ (pkgs.lib.optional (!loadDefaults) "--no-default-config")
            ++ extraArgs;
        in
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [
            pkgs.nodejs
            config.packages.pi-acp
          ];
          text = ''
            export PHENIX_HEADLESS_PROGRAM="${pkgs.nodejs}/bin/node"
            export PHENIX_HEADLESS_ENTRY="${config.packages.phenix-pi-package}/headless/main.ts"
            export PHENIX_SOURCE_ROOT="${config.packages.phenix-pi-package}"
            ${configExport}
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

      phenixSmoke =
        pkgs.runCommand "phenix-frontend-smoke"
          {
            nativeBuildInputs = [
              phenix
              phenixAcpSmoke
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
            mkdir -p "$XDG_CONFIG_HOME/phenix" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

            cat > "$XDG_CONFIG_HOME/phenix/init.lua" <<'EOF_CONFIG'
            phenix.keymap.del("global", "<C-q>")
            assert(type(phenix.layout.set) == "function")
            EOF_CONFIG

            phenix --print-default-config | grep -q 'phenix.layout.set'
            phenix --check
            phenix-configured-smoke --check
            phenix-acp-smoke
            touch "$out"
          '';
    in
    {
      packages = {
        phenix-tui = phenixTui;
        phenix-acp-smoke = phenixAcpSmoke;
        inherit phenix;
        default = pkgs.lib.mkForce phenix;
      };

      legacyPackages.phenixFrontend = {
        inherit mkPhenixWrapper;
        defaultLua = ../rust/crates/phenix-ui-lua/default.lua;
        defaultAcpConfig = ../config/phenix-acp;
      };

      apps.phenix.program = pkgs.lib.getExe phenix;
      apps.default.program = pkgs.lib.getExe phenix;

      checks.phenix-frontend = phenixSmoke;
    };
}
