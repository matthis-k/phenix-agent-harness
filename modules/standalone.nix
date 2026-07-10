{ inputs, lib, ... }: {
  perSystem = { pkgs, system, ... }: let
    wlib = inputs.nix-wrapper-modules.lib;

    wrappedPi = wlib.wrapPackage [
      { inherit pkgs; }
      {
        package = pkgs.pi-coding-agent;
        env.PI_SKIP_VERSION_CHECK = "1";
        env.PI_TELEMETRY = "0";
      }
    ];
  in {
    packages.default = wrappedPi;
    packages.pi = wrappedPi;
  };
}
