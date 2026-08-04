{ ... }:

{
  perSystem =
    { pkgs, ... }:
    let
      source = pkgs.lib.cleanSource ../rust;
      check = pkgs.runCommand "phenix-rust-core-check"
        {
          nativeBuildInputs = [
            pkgs.cargo
            pkgs.clippy
            pkgs.rustc
            pkgs.rustfmt
            pkgs.stdenv.cc
          ];
        }
        ''
          cp -R ${source}/. source
          chmod -R u+w source
          cd source
          export HOME="$TMPDIR/home"
          export CARGO_HOME="$TMPDIR/cargo"
          cargo fmt --all --check
          cargo clippy --workspace --all-targets --locked --offline -- -D warnings
          cargo test --workspace --locked --offline
          touch "$out"
        '';
    in
    {
      checks.phenix-rust-core = check;
      packages.phenix-rust-core-check = check;
    };
}
