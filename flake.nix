{
  description = "Phenix agent harness for Pi";

  inputs = {
    phenix-pins.url = "github:matthis-k/phenix-pins";
    nixpkgs.follows = "phenix-pins/nixpkgs";

    nix-wrapper-modules = {
      url = "github:BirdeeHub/nix-wrapper-modules";
      inputs.nixpkgs.follows = "phenix-pins/nixpkgs";
    };
  };

  outputs = inputs@{ self, phenix-pins, nix-wrapper-modules, ... }:
    phenix-pins.inputs.flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" ];
      imports = [
        ./modules/standalone.nix
      ];
      flake.flakeModules.default = import ./modules/flake-module.nix;
    };
}
