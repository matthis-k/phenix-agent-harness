{
  lib,
  pkgs,
  pi,
  packages,
  hash,
}:

let
  packageNames = lib.attrNames packages;
  packageSpecs = lib.attrValues packages;
  packageSetId = builtins.substring 0 12 (
    builtins.hashString "sha256" (builtins.toJSON packages)
  );
in
pkgs.stdenvNoCC.mkDerivation {
  pname = "pi-npm-packages";
  version = packageSetId;

  nativeBuildInputs = [
    pi
    pkgs.nodejs
    pkgs.git
    pkgs.cacert
  ];

  impureEnvVars = lib.fetchers.proxyImpureEnvVars ++ [
    "GIT_PROXY_COMMAND"
    "SOCKS_SERVER"
  ];

  dontUnpack = true;
  dontConfigure = true;
  dontFixup = true;

  outputHash = hash;
  outputHashAlgo = "sha256";
  outputHashMode = "recursive";

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR/home"
    export PI_CODING_AGENT_DIR="$TMPDIR/pi-agent"
    export PI_SKIP_VERSION_CHECK=1
    export PI_TELEMETRY=0
    export CI=1

    export npm_config_cache="$TMPDIR/npm-cache"
    export npm_config_audit=false
    export npm_config_fund=false
    export npm_config_update_notifier=false

    mkdir -p "$HOME" "$PI_CODING_AGENT_DIR" "$TMPDIR/work"
    cd "$TMPDIR/work"

    ${lib.concatMapStringsSep "\n" (spec: ''
      echo "installing Pi package ${spec}"
      ${pi}/bin/pi install ${lib.escapeShellArg spec}
    '') packageSpecs}

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp -R "$PI_CODING_AGENT_DIR/npm" "$out/npm"
    chmod -R u+w "$out"

    ${lib.concatMapStringsSep "\n" (name: ''
      test -f "$out/npm/node_modules/${name}/package.json"
    '') packageNames}

    cat > "$out/package-names" <<'NAMES'
    ${lib.concatStringsSep "\n" packageNames}
    NAMES

    runHook postInstall
  '';
}
