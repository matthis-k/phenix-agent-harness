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
      cargo generate-lockfile
      cargo fmt --all --check
      cargo check --workspace --all-targets --locked
      cargo clippy --workspace --all-targets --locked -- -D warnings
      cargo test --workspace --all-targets --locked
    '';
  };

  tasks."maintenance:rust-core".exec = "maintenance-check-rust-core";
  tasks."maintenance:check".after = [ "maintenance:rust-core" ];
}
