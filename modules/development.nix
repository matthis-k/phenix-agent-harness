{ ... }:
{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:
    let
      tooling = import ./tooling.nix { inherit pkgs; };
      updatePiNpmLock = pkgs.writeShellApplication {
        name = "update-pi-npm-lock";
        runtimeInputs = [ pkgs.nodejs ];
        text = ''
          if [[ ! -f modules/pi-npm/package.json ]]; then
            echo "run this command from the phenix-agent-harness repository root" >&2
            exit 1
          fi

          npm install \
            --prefix modules/pi-npm \
            --package-lock-only \
            --ignore-scripts \
            --legacy-peer-deps \
            --no-audit \
            --no-fund

          echo "Updated modules/pi-npm/package-lock.json"
        '';
      };
    in
    {
      packages.update-pi-npm-lock = updatePiNpmLock;

      devShells.default = pkgs.mkShell {
        name = "phenix-agent-harness-dev";
        packages =
          tooling.agentRuntime
          ++ [
            pkgs.devenv
            updatePiNpmLock
            self'.packages.stitch
            self'.packages.stitch-mcp
          ];
        shellHook = ''
          echo "phenix-agent-harness dev shell"
          echo "  maintenance: devenv test"
          echo "  fixes:       devenv tasks run maintenance:fix"
          echo "  npm lock:    update-pi-npm-lock"
          echo "  stitch:      stitch workspace discover --json"
        '';
      };
    };
}
