{
  description = "Phenix agent harness for Pi";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, self }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];
  in {
    packages = forAllSystems (system: let
      pkgs = import nixpkgs { inherit system; };

      phenixConfig = pkgs.stdenv.mkDerivation {
        name = "phenix-pi-config";
        src = ./config/phenix-pi;
        installPhase = ''
          mkdir -p $out
          cp -R . $out/
        '';
      };

      wrappedPi = pkgs.symlinkJoin {
        name = "pi";
        paths = [ pkgs.pi-coding-agent ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/pi \
            --set PI_PACKAGE_DIR "${phenixConfig}" \
            --set PI_SKIP_VERSION_CHECK "1" \
            --set PI_TELEMETRY "0"
        '';
      };
    in {
      default = wrappedPi;
      pi = wrappedPi;
      phenix-config = phenixConfig;
    });
  };
}
