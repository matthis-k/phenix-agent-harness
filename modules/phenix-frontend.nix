_:

{
  perSystem =
    { config, pkgs, ... }:
    let
      rustSource = pkgs.lib.cleanSource ../rust;

      # The user-facing runtime is one Rust workspace product. Build only the
      # binaries that are actually shipped. Unit/integration/system tests are
      # owned by the Cargo CI layers rather than rerun during packaging.
      phenixRustRuntime = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-rust-runtime";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-tui"
          "--package"
          "phenix-conductor"
          "--bin"
          "phenix"
          "--bin"
          "phenix-conductor"
        ];
        doCheck = false;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"

          phenix_binary="$(find target -path '*/release/phenix' -type f -print -quit)"
          conductor_binary="$(find target -path '*/release/phenix-conductor' -type f -print -quit)"
          test -n "$phenix_binary"
          test -n "$conductor_binary"

          cp "$phenix_binary" "$out/bin/phenix"
          cp "$conductor_binary" "$out/bin/phenix-conductor"
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
        doCheck = false;

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
          configDir ? null,
          loadDefaults ? true,
          extraArgs ? [ ],
        }:
        let
          wrapperArguments =
            (pkgs.lib.optionals (configDir != null) [
              "--config-dir"
              (toString configDir)
            ])
            ++ (pkgs.lib.optional (!loadDefaults) "--no-default-config")
            ++ extraArgs;
        in
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [
            config.packages.pi-acp
            phenixRustRuntime
          ];
          text = ''
            export PHENIX_CONDUCTOR_COMMAND="${phenixRustRuntime}/bin/phenix-conductor"
            exec "${phenixRustRuntime}/bin/phenix" ${pkgs.lib.escapeShellArgs wrapperArguments} "$@"
          '';
        };

      # The ordinary package contains no orchestration policy. Users configure it
      # through their own XDG config or an explicit --config-dir.
      phenix = mkPhenixWrapper { };

      configuredSmokeDir = pkgs.runCommand "phenix-configured-smoke-config" { } ''
        cp -R ${../config/phenix-harness} "$out"
        chmod u+w "$out/config.lua"
        cat >> "$out/config.lua" <<'EOF_CONFIG'
        phenix.keymap.del("global", "<C-q>")
        phenix.theme.set("Accent", { fg = "#ffffff", bold = true })
        assert(type(phenix.ui.pane.resize) == "function")
        assert(phenix.layout == nil)
        EOF_CONFIG
      '';

      configuredSmokePackage = mkPhenixWrapper {
        name = "phenix-configured-smoke";
        configDir = configuredSmokeDir;
      };

      phenixSmoke =
        pkgs.runCommand "phenix-product-smoke"
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
            mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"

            phenix --print-default-config | grep -Fq 'phenix.theme.set("Normal"'
            if phenix --check; then
              echo "unconfigured phenix unexpectedly accepted implicit runtime policy" >&2
              exit 1
            fi
            phenix-configured-smoke --check
            phenix-acp-smoke
            touch "$out"
          '';
    in
    {
      packages = {
        phenix-runtime = phenixRustRuntime;
        phenix-tui = phenixRustRuntime;
        phenix-conductor = phenixRustRuntime;
        phenix-acp-smoke = phenixAcpSmoke;
        inherit phenix;
        default = pkgs.lib.mkForce phenix;
      };

      apps.phenix.program = pkgs.lib.getExe phenix;
      apps.default.program = pkgs.lib.getExe phenix;

      checks.phenix-product-smoke = phenixSmoke;
    };
}
