{
  description = "Wrapped opencode with Phenix MCP and workflow configuration";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    phenix-pins.url = "github:matthis-k/phenix-pins";
    nixpkgs.follows = "phenix-pins/nixpkgs";
    nix-wrapper-modules.url = "github:BirdeeHub/nix-wrapper-modules";
    nix-wrapper-modules.inputs.nixpkgs.follows = "phenix-pins/nixpkgs";
    phenix-tend.url = "github:matthis-k/phenix-tend";
    phenix-tend.inputs.phenix-pins.follows = "phenix-pins";
    phenix-stitch.url = "github:matthis-k/phenix-stitch";
    phenix-stitch.inputs.phenix-pins.follows = "phenix-pins";
    nixpkgs-unstable.follows = "phenix-pins/nixpkgs-unstable";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      imports = [ ./modules/standalone.nix ];
      flake.flakeModules.default = import ./modules/flake-module.nix;
    };
}
