{
  description = "Minimal Phenix coding-agent harness for Pi";

  inputs = {
    phenix-pins.url = "github:matthis-k/phenix-pins";
    nixpkgs.follows = "phenix-pins/nixpkgs";

    phenix-stitch = {
      url = "github:matthis-k/phenix-stitch?ref=refactor/scoped-stitch-maintenance";
      inputs = {
        flake-parts.follows = "phenix-pins/flake-parts";
        phenix-pins.follows = "phenix-pins";
      };
    };
  };

  outputs =
    inputs@{
      self,
      phenix-pins,
      ...
    }:
    phenix-pins.inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      imports = [
        ./modules/pi-packages.nix
        ./modules/standalone.nix
        ./modules/development.nix
        ./modules/stitch.nix
      ];

      flake.flakeModules.default = import ./modules/flake-module.nix;
    };
}
