{ pkgs, ... }:

pkgs.rustPlatform.buildRustPackage {
  pname = "phenix-agent-comm";
  version = "0.1.0";

  src = ./.;
  cargoLock.lockFile = ./Cargo.lock;

  nativeBuildInputs = [ pkgs.pkg-config ];
  buildInputs = [ pkgs.sqlite ];
}
