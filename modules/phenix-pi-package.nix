# Build config/phenix-pi as a store-backed npm package with node_modules.
#
# Uses buildNpmPackage with a pre-generated package-lock.json and
# npmDepsHash (computed by prefetch-npm-deps).  Pi core peer dependencies
# are declared in the package.json but have been patched into the lock file
# so Nix can fetch them deterministically.
{
  pkgs,
  lib,
  ...
}:

let
  packageJson = lib.importJSON ../config/phenix-pi/package.json;
in
pkgs.buildNpmPackage {
  pname = "phenix-pi-package";
  version = packageJson.version or "0.1.5";

  src = ../config/phenix-pi;

  # Hash of npm dependencies, computed by:
  #   prefetch-npm-deps config/phenix-pi/package-lock.json
  npmDepsHash = "sha256-K96rC2YuZGN73qnANbTAK8b7IsSpFJQy5pVzXnCGPpQ=";

  # Use npm deps fetcher v2 which handles lockfileV3 more robustly.
  # Note: importNpmLock was attempted but fails with ENOTCACHED errors for
  # transitive dependencies. npmDepsHash with v2 fetcher is the reliable alternative.
  npmDepsFetcherVersion = 2;

  # Skip npm build — phenix-pi is a resource/config package, not a build.
  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp -R . "$out/"

    runHook postInstall
  '';

  meta = {
    description = "Store-backed Phenix Pi package with pinned Pi package dependencies";
    license = lib.licenses.mit;
  };
}
