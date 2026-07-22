{ config, lib, ... }:

{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:

    let
      tooling = import ./tooling.nix { inherit pkgs; };
      phenixPiPackage = self'.packages.phenix-pi-package;
      mcpConfig = ./phenix-pi/config/mcp.json;

      wrappedPi = pkgs.writeShellApplication {
        name = "pi";
        runtimeInputs = tooling.harnessRuntime ++ [
          phenixPiPackage
          pkgs.mcp-nixos
          self'.packages.stitch
          self'.packages.stitch-mcp
        ];

        text = ''
          agent_dir="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

          mkdir -p "$agent_dir"
          chmod 0700 "$agent_dir" 2>/dev/null || true

          lsp_defaults_file="$agent_dir/lsp.phenix-defaults.json"

          install -m 0600 \
            "${phenixPiPackage}/config/lsp.json" \
            "$lsp_defaults_file"

          if [[ ! -e "$agent_dir/lsp.json" ]]; then
            cp "$lsp_defaults_file" "$agent_dir/lsp.json"
            chmod 0600 "$agent_dir/lsp.json"
          fi

          mcp_defaults_file="$agent_dir/mcp.phenix-defaults.json"

          install -m 0600 \
            "${phenixPiPackage}/config/mcp.json" \
            "$mcp_defaults_file"

          node "${phenixPiPackage}/runtime/merge-mcp-defaults.mjs" \
            "$mcp_defaults_file" \
            "$agent_dir/mcp.json"

          models_defaults_file="$agent_dir/models.phenix-defaults.json"

          install -m 0600 \
            "${phenixPiPackage}/config/models.json" \
            "$models_defaults_file"

          node "${phenixPiPackage}/runtime/merge-model-defaults.mjs" \
            "$models_defaults_file" \
            "$agent_dir/models.json"

          export PI_CODING_AGENT_DIR="$agent_dir"
          export PI_SKIP_VERSION_CHECK=1
          export PI_TELEMETRY=0

          export HYPA_PI_MODE="''${HYPA_PI_MODE:-replace}"

          SELF=$(readlink -f "''${BASH_SOURCE[0]:-$0}" 2>/dev/null) || SELF=pi
          export PHENIX_PI_WRAPPER="$SELF"
          export PHENIX_PI_BINARY="${self'.packages.pi-coding-agent}/bin/pi"
          export PI_SUBAGENT_PI_BINARY="$SELF"
          export HYPA_PI_ENABLE_MCP_PROXY="''${HYPA_PI_ENABLE_MCP_PROXY:-0}"
          export HYPA_PI_ASK_NON_INTERACTIVE="''${HYPA_PI_ASK_NON_INTERACTIVE:-allow}"

          exec "${self'.packages.pi-coding-agent}/bin/pi" \
            -e "${phenixPiPackage}" \
            "$@"
        '';
      };

      mcpDefaultsSmoke =
        pkgs.runCommand "phenix-mcp-defaults-smoke"
          {
            nativeBuildInputs = [ pkgs.jq ];
          }
          ''
            jq -e '
              .settings.directTools == false and
              .mcpServers.stitch.command == "stitch-mcp" and
              .mcpServers.stitch.lifecycle == "lazy" and
              .mcpServers.nixos.command == "mcp-nixos" and
              .mcpServers.nixos.lifecycle == "lazy" and
              .mcpServers."qt-docs".url == "https://qt-docs-mcp.qt.io/mcp" and
              .mcpServers."qt-docs".lifecycle == "lazy" and
              .mcpServers.context7.url == "https://mcp.context7.com/mcp" and
              .mcpServers.context7.lifecycle == "lazy"
            ' ${mcpConfig}

            test -x ${pkgs.mcp-nixos}/bin/mcp-nixos
            touch "$out"
          '';
    in
    {
      packages = {
        default = wrappedPi;
        pi = wrappedPi;
      };

      checks = {
        mcp-defaults = mcpDefaultsSmoke;
        pi-wrapper = wrappedPi;
      };
    };
}
