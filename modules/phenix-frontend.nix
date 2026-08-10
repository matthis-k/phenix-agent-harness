_:

{
  perSystem =
    { config, pkgs, ... }:
    let
      rustSource = pkgs.lib.cleanSource ../rust;

      phenixConductor = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-conductor";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-conductor"
          "--bin"
          "phenix-conductor"
        ];
        doCheck = false;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          conductor_binary="$(find target -path '*/release/phenix-conductor' -type f -print -quit)"
          test -n "$conductor_binary"
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

      phenixNvim = pkgs.vimUtils.buildVimPlugin {
        pname = "phenix.nvim";
        version = "0";
        src = ../nvim;
      };

      packagedConfigDir = pkgs.runCommand "phenix-harness-config" { } ''
        mkdir -p "$out"
        cp -R ${../config/phenix-harness}/. "$out/"
      '';

      phenix = pkgs.writeShellApplication {
        name = "phenix";
        runtimeInputs = [
          pkgs.neovim
          config.packages.pi-acp
          phenixConductor
        ];
        text = ''
          export PHENIX_CONDUCTOR_COMMAND="''${PHENIX_CONDUCTOR_COMMAND:-${phenixConductor}/bin/phenix-conductor}"
          export PHENIX_CONFIG_DIR="''${PHENIX_CONFIG_DIR:-${packagedConfigDir}}"
          exec nvim \
            --cmd ${pkgs.lib.escapeShellArg "set runtimepath^=${pkgs.vimPlugins.nvim-nui}"} \
            --cmd ${pkgs.lib.escapeShellArg "set runtimepath^=${phenixNvim}"} \
            -c PhenixOpen \
            "$@"
        '';
      };

      phenixNvimSmoke = pkgs.runCommand "phenix-nvim-smoke" {
        nativeBuildInputs = [
          pkgs.neovim
          pkgs.python3
        ];
      } ''
        export HOME="$TMPDIR/home"
        export XDG_CACHE_HOME="$HOME/.cache"
        export XDG_CONFIG_HOME="$HOME/.config"
        export XDG_DATA_HOME="$HOME/.local/share"
        export XDG_STATE_HOME="$HOME/.local/state"
        mkdir -p "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

        export PHENIX_TEST_FIXTURE=${../nvim/tests/fixture_agent.py}
        export PHENIX_TEST_PYTHON=${pkgs.python3}/bin/python3
        export PHENIX_TEST_CONFIG=${../config/phenix-harness/init.lua}

        nvim --headless -u NONE \
          --cmd ${pkgs.lib.escapeShellArg "set runtimepath^=${pkgs.vimPlugins.nvim-nui}"} \
          --cmd ${pkgs.lib.escapeShellArg "set runtimepath^=${phenixNvim}"} \
          -c ${pkgs.lib.escapeShellArg "lua dofile('${../nvim/tests/smoke.lua}')"} \
          -c 'qa!'

        touch "$out"
      '';

      phenixProductSmoke = pkgs.runCommand "phenix-product-smoke" {
        nativeBuildInputs = [ phenixAcpSmoke ];
      } ''
        phenix-acp-smoke
        touch "$out"
      '';
    in
    {
      packages = {
        phenix = phenix;
        phenix-nvim = phenixNvim;
        phenix-conductor = phenixConductor;
        phenix-acp-smoke = phenixAcpSmoke;
        default = pkgs.lib.mkForce phenix;
      };

      apps.phenix.program = pkgs.lib.getExe phenix;
      apps.default.program = pkgs.lib.getExe phenix;

      checks = {
        phenix-nvim-smoke = phenixNvimSmoke;
        phenix-product-smoke = phenixProductSmoke;
      };
    };
}
