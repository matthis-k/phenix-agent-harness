{
  description = "Phenix agent harness wrappers for Pi";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";

    phenix-pins.url = "github:matthis-k/phenix-pins";

    nixpkgs.follows = "phenix-pins/nixpkgs";
    nixpkgs-unstable.follows = "phenix-pins/nixpkgs-unstable";

    nix-wrapper-modules.url = "github:BirdeeHub/nix-wrapper-modules";
    nix-wrapper-modules.inputs.nixpkgs.follows = "phenix-pins/nixpkgs";

    phenix-tend.url = "github:matthis-k/phenix-tend";
    phenix-tend.inputs.phenix-pins.follows = "phenix-pins";

    phenix-stitch.url = "github:matthis-k/phenix-stitch";
    phenix-stitch.inputs.phenix-pins.follows = "phenix-pins";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      imports = [ ./modules/package.nix ];

      flake = {
        flakeModules.default = import ./modules/flake-module.nix;

        wrappers.piModule =
          (inputs.nix-wrapper-modules.lib.evalModule (import ./modules/wrapper-module.nix)).config;
      };
    };
}
