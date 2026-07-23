{
  description = "Phenix recursive agent and workflow harness for Pi";

  inputs = {
    phenix-pins.url = "github:matthis-k/phenix-pins";
    nixpkgs.follows = "phenix-pins/nixpkgs";

    pi-src = {
      url = "github:earendil-works/pi/v0.80.10";
      flake = false;
    };

    phenix-stitch = {
      url = "github:matthis-k/phenix-stitch";
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
