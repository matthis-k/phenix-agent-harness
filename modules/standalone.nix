_:

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

          seed_config() {
            local name="$1"
            local source="${phenixPiPackage}/config/$name"
            local target="$agent_dir/$name"
            if [[ ! -e "$target" && -f "$source" ]]; then
              install -m 0600 "$source" "$target"
            fi
          }

          seed_config lsp.json
          seed_config mcp.json

          export PI_CODING_AGENT_DIR="$agent_dir"
          export PI_SKIP_VERSION_CHECK=1
          export PI_TELEMETRY=0
          export HYPA_PI_MODE="''${HYPA_PI_MODE:-replace}"
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
