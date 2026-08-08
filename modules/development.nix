_: {
  perSystem =
    {
      pkgs,
      self',
      ...
    }:
    {
      devShells.default = pkgs.mkShell {
        name = "phenix-agent-harness-dev";
        packages = [
          pkgs.actionlint
          pkgs.cargo
          pkgs.clippy
          pkgs.git
          pkgs.lua-language-server
          pkgs.nixd
          pkgs.nixfmt
          pkgs.rust-analyzer
          pkgs.rustc
          pkgs.rustfmt
          pkgs.statix
          pkgs.taplo
          self'.packages.stitch
          self'.packages.stitch-mcp
        ];
        shellHook = ''
          echo "phenix-agent-harness dev shell"
          echo "  checks: devenv test"
          echo "  fixes:  devenv tasks run maintenance:fix"
        '';
      };
    };
}
