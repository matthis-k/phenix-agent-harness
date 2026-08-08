{ pkgs, ... }:
let
  repositoryRoot = ''repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cd "$repo_root/rust"'';
in
{
  scripts = {
    "maintenance-check-rust-format" = {
      packages = [
        pkgs.cargo
        pkgs.git
        pkgs.rustfmt
      ];
      exec = ''
        ${repositoryRoot}
        cargo fmt --all --check
      '';
    };

    "maintenance-fix-rust-format" = {
      packages = [
        pkgs.cargo
        pkgs.git
        pkgs.rustfmt
      ];
      exec = ''
        ${repositoryRoot}
        cargo fmt --all
      '';
    };

    "maintenance-check-rust-compile" = {
      packages = [
        pkgs.cargo
        pkgs.git
        pkgs.rustc
      ];
      exec = ''
        ${repositoryRoot}
        export CARGO_HOME="$TMPDIR/phenix-cargo-home"
        cargo check --workspace --all-targets --locked
      '';
    };

    "maintenance-check-rust-clippy" = {
      packages = [
        pkgs.cargo
        pkgs.clippy
        pkgs.git
        pkgs.rustc
      ];
      exec = ''
        ${repositoryRoot}
        export CARGO_HOME="$TMPDIR/phenix-cargo-home"
        cargo clippy --workspace --all-targets --locked -- -D warnings
      '';
    };

    "maintenance-fix-rust-clippy" = {
      packages = [
        pkgs.cargo
        pkgs.clippy
        pkgs.git
        pkgs.rustc
      ];
      exec = ''
        ${repositoryRoot}
        export CARGO_HOME="$TMPDIR/phenix-cargo-home"
        cargo clippy --fix --workspace --all-targets --locked --allow-dirty --allow-staged
        cargo clippy --workspace --all-targets --locked -- -D warnings
      '';
    };

    "maintenance-check-rust-tests" = {
      packages = [
        pkgs.cargo
        pkgs.git
        pkgs.rustc
      ];
      exec = ''
        ${repositoryRoot}
        export CARGO_HOME="$TMPDIR/phenix-cargo-home"
        cargo test --workspace --all-targets --locked
      '';
    };
  };

  tasks = {
    "maintenance:rust-format".exec = "maintenance-check-rust-format";
    "maintenance:rust-compile".exec = "maintenance-check-rust-compile";
    "maintenance:rust-clippy".exec = "maintenance-check-rust-clippy";
    "maintenance:rust-tests".exec = "maintenance-check-rust-tests";
    "maintenance:fix:rust-clippy".exec = "maintenance-fix-rust-clippy";
    "maintenance:fix:rust-format" = {
      exec = "maintenance-fix-rust-format";
      after = [ "maintenance:fix:rust-clippy" ];
    };

    "maintenance:format".after = [ "maintenance:rust-format" ];
    "maintenance:check".after = [
      "maintenance:rust-compile"
      "maintenance:rust-clippy"
      "maintenance:rust-tests"
    ];
    "maintenance:fix".after = [ "maintenance:fix:rust-format" ];
  };
}
