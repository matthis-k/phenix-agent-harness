_:

{
  perSystem =
    { pkgs, ... }:
    let
      source = pkgs.lib.fileset.toSource {
        root = ../.;
        fileset = pkgs.lib.fileset.unions [
          ../rust
          ../config/phenix-harness
        ];
      };
      check = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-rust-core-check";
        version = "0";
        src = source;
        sourceRoot = "source/rust";

        cargoLock.lockFile = ../rust/Cargo.lock;
        nativeBuildInputs = [
          pkgs.clippy
          pkgs.rustfmt
        ];

        buildPhase = ''
          runHook preBuild
          cargo fmt --all --check
          cargo check --workspace --all-targets --locked --offline
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
