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

      wrappedPi = pkgs.writeShellApplication {
        name = "pi";
        runtimeInputs = tooling.harnessRuntime ++ [
          phenixPiPackage
          self'.packages.stitch
          self'.packages.stitch-mcp
        ];

        text = ''
          agent_dir="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
          mkdir -p "$agent_dir"
          chmod 0700 "$agent_dir" 2>/dev/null || true

          export PI_CODING_AGENT_DIR="$agent_dir"
          export PI_SKIP_VERSION_CHECK=1
          export PI_TELEMETRY=0

          exec "${self'.packages.pi-coding-agent}/bin/pi" \
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

      checks.pi-wrapper = wrappedPi;
    };
}
