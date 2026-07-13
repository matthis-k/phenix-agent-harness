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

      wrappedPi = pkgs.writeShellApplication {
        name = "pi";
        runtimeInputs = tooling.agentRuntime;

        text = ''
          agent_dir="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

          mkdir -p "$agent_dir"
          chmod 0700 "$agent_dir" 2>/dev/null || true

          defaults_file="$agent_dir/lsp.phenix-defaults.json"

          install -m 0600 \
            "${phenixPiPackage}/config/lsp.json" \
            "$defaults_file"

          if [[ ! -e "$agent_dir/lsp.json" ]]; then
            cp "$defaults_file" "$agent_dir/lsp.json"
            chmod 0600 "$agent_dir/lsp.json"
          fi

          export PI_CODING_AGENT_DIR="$agent_dir"
          export PI_SKIP_VERSION_CHECK=1
          export PI_TELEMETRY=0

          export HYPA_PI_MODE="''${HYPA_PI_MODE:-replace}"

          # Point phenix_delegate at this wrapper so child pi processes inherit
          # the same extension set and environment. Always replace inherited
          # values because stale repo-local result symlinks can otherwise poison
          # nested subagent spawns with ENOTDIR.
          SELF=$(readlink -f "''${BASH_SOURCE[0]:-$0}" 2>/dev/null) || SELF=pi
          export PHENIX_PI_WRAPPER="$SELF"
          export PI_SUBAGENT_PI_BINARY="$SELF"
          export HYPA_PI_ENABLE_MCP_PROXY="''${HYPA_PI_ENABLE_MCP_PROXY:-0}"
          export HYPA_PI_ASK_NON_INTERACTIVE="''${HYPA_PI_ASK_NON_INTERACTIVE:-allow}"

          exec "${pkgs.pi-coding-agent}/bin/pi" \
            -e "${phenixPiPackage}" \
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
