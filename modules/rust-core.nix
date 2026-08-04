{ ... }:

{
  perSystem =
    { pkgs, ... }:
    let
      source = pkgs.lib.cleanSource ../rust;
      check = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-rust-core-check";
        version = "0";
        src = source;

        cargoLock.lockFile = ../rust/Cargo.lock;
        nativeBuildInputs = [
          pkgs.clippy
          pkgs.rustfmt
        ];

        buildPhase = ''
          runHook preBuild
          cargo fmt --all --check
          cargo clippy --workspace --all-targets --locked --offline -- -D warnings
          runHook postBuild
        '';

        checkPhase = ''
          runHook preCheck
          cargo test --workspace --all-targets --locked --offline
          runHook postCheck
        '';

        installPhase = ''
          mkdir -p "$out"
          touch "$out/passed"
        '';
      };
    in
    {
      checks.phenix-rust-core = check;
      packages.phenix-rust-core-check = check;
    };
}
