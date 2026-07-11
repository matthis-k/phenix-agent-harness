{
  description = "Minimal Phenix coding-agent harness for Pi";

  inputs = {
    phenix-pins.url = "github:matthis-k/phenix-pins";
    nixpkgs.follows = "phenix-pins/nixpkgs";

    pi-hypa = {
      url = "github:Hypabolic/Hypa";
      flake = false;
    };

    rpiv-web-tools = {
      url = "github:juicesharp/rpiv-mono";
      flake = false;
    };

    pi-context-tools = {
      url = "github:theduke/pi-context-tools";
      flake = false;
    };

    pi-mcp-adapter = {
      url = "github:nicobailon/pi-mcp-adapter";
      flake = false;
    };

    pi-subagents = {
      url = "github:nicobailon/pi-subagents";
      flake = false;
    };

    pi-reduce = {
      url = "github:toorusr/pi-reduce";
      flake = false;
    };

    pi-web-search = {
      url = "github:ttttmr/pi-web-search";
      flake = false;
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
      ];

      flake.flakeModules.default = import ./modules/flake-module.nix;
    };
}
