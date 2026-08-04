{ pkgs, ... }:
let
  repositoryRoot = ''repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$repo_root/rust"'';
in
{
  scripts."maintenance-check-rust-core" = {
    packages = [
      pkgs.cargo
      pkgs.clippy
      pkgs.git
      pkgs.rustc
      pkgs.rustfmt
    ];
    exec = ''
      ${repositoryRoot}
      export CARGO_HOME="$TMPDIR/phenix-cargo-home"
      cargo fmt --all --check
      cargo clippy --workspace --all-targets --locked --offline -- -D warnings
      cargo test --workspace --locked --offline
    '';
  };

  tasks."maintenance:rust-core".exec = "maintenance-check-rust-core";
  tasks."maintenance:check".after = [ "maintenance:rust-core" ];
}
