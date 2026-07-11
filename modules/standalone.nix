{ config, lib, ... }:

{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:

    let
      phenixShell = self'.packages.phenix-shell;
      piNpmPackages = self'.packages.phenix-pi-npm-packages;

      runtimeInputs = with pkgs; [
        bash
        coreutils
        diffutils
        file
        findutils
        gawk
        git
        gh
        gnugrep
        gnused
        jq
        patch
        ripgrep
        fd
        ast-grep
        tree
        which

        nix
        nixd

        cargo
        rustc
        clippy
        rust-analyzer

        lua-language-server

        nodejs
        typescript
        typescript-language-server
        vscode-langservers-extracted

        taplo

        yaml-language-server

        basedpyright
      ];

      wrappedPi = pkgs.writeShellApplication {
        name = "pi";
        inherit runtimeInputs;

        text = ''
          agent_dir="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

          mkdir -p "$agent_dir"
          chmod 0700 "$agent_dir" 2>/dev/null || true

          defaults_file="$agent_dir/lsp.phenix-defaults.json"

          install -m 0600 \
            "${phenixShell}/config/lsp.json" \
            "$defaults_file"

          if [[ ! -e "$agent_dir/lsp.json" ]]; then
            cp "$defaults_file" "$agent_dir/lsp.json"
            chmod 0600 "$agent_dir/lsp.json"
          fi

          export PI_CODING_AGENT_DIR="$agent_dir"
          export PI_SKIP_VERSION_CHECK=1
          export PI_TELEMETRY=0

          export HYPA_PI_MODE="''${HYPA_PI_MODE:-replace}"
          export HYPA_PI_ENABLE_MCP_PROXY="''${HYPA_PI_ENABLE_MCP_PROXY:-0}"
          export HYPA_PI_ASK_NON_INTERACTIVE="''${HYPA_PI_ASK_NON_INTERACTIVE:-allow}"

          pi_args=(
            -e "${phenixShell}"
            -e "${piNpmPackages}/npm/node_modules/pi-subagents"
            -e "${piNpmPackages}/npm/node_modules/pi-reduce"
          )

          exec "${pkgs.pi-coding-agent}/bin/pi" \
            "''${pi_args[@]}" \
            "$@"
        '';
      };
    in
    {
      packages = {
        default = wrappedPi;
        pi = wrappedPi;
      };

      checks = {
        pi-wrapper = wrappedPi;
      };
    };
}
