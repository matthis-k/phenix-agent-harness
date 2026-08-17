_: {
  perSystem =
    { pkgs, ... }:
    let
      rustSource = pkgs.lib.cleanSource ../rust;

      phenixConductor = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-conductor";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-conductor"
          "--bin"
          "phenix-conductor"
        ];
        nativeBuildInputs = [
          pkgs.cmake
          pkgs.makeWrapper
        ];
        doCheck = false;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin" "$out/libexec"
          conductor_binary="$(find target -path '*/release/phenix-conductor' -type f -print -quit)"
          test -n "$conductor_binary"
          cp "$conductor_binary" "$out/libexec/phenix-conductor"
          makeWrapper "$out/libexec/phenix-conductor" "$out/bin/phenix-conductor" \
            --set-default SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
            --set-default NIX_SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          runHook postInstall
        '';
      };

      phenixAcpSmoke = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-acp-smoke";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-acp-presets"
          "--bin"
          "phenix-acp-smoke"
        ];
        doCheck = false;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          smoke_binary="$(find target -path '*/release/phenix-acp-smoke' -type f -print -quit)"
          test -n "$smoke_binary"
          cp "$smoke_binary" "$out/bin/phenix-acp-smoke"
          runHook postInstall
        '';
      };

      phenixProductSmoke =
        pkgs.runCommand "phenix-product-smoke"
          {
            nativeBuildInputs = [
              phenixAcpSmoke
              phenixConductor
              pkgs.jq
            ];
          }
          ''
            phenix-acp-smoke

            export PHENIX_CREDENTIAL_FILE="$TMPDIR/credentials.json"
            export PHENIX_MODEL="openai-codex/product-smoke-model"
            response="$TMPDIR/initialize.jsonl"
            printf '%s\n' '{"id":1,"command":{"type":"initialize","after_sequence":null}}' |
              phenix-conductor > "$response"

            jq -e '
              .type == "response"
              and .id == 1
              and .status == "ok"
              and .result.type == "initialized"
              and ([
                .result.backends[]
                | select(.backend == "phenix")
                | .models[]
                | select(
                    .target.backend == "phenix"
                    and .target.provider == "openai-codex"
                    and .target.model == "product-smoke-model"
                  )
              ] | length == 1)
            ' "$response" >/dev/null

            touch "$out"
          '';
    in
    {
      packages = {
        phenix-conductor = phenixConductor;
        phenix-acp-smoke = phenixAcpSmoke;
        default = phenixConductor;
      };

      apps = {
        phenix-conductor.program = "${phenixConductor}/bin/phenix-conductor";
        default.program = "${phenixConductor}/bin/phenix-conductor";
      };

      checks.phenix-product-smoke = phenixProductSmoke;
    };
}
