{ inputs, ... }:

{
  perSystem =
    { pkgs, ... }:
    let
      piVersion = "0.80.10";

      # Pi is an external ACP backend implementation. Build the pinned upstream
      # CLI without Phenix-specific source patches; Phenix owns UX and
      # orchestration in the native Rust harness instead of modifying Pi's TUI.
      piCodingAgent = pkgs.buildNpmPackage {
        pname = "pi-coding-agent";
        version = piVersion;
        src = inputs.pi-src;

        npmDepsHash = "sha256-XGvDNH+eilsgc0Z7ITqbitB/9RVc+WuDfCcr1pibNqk=";
        npmWorkspace = "packages/coding-agent";
        npmRebuildFlags = [ "--ignore-scripts" ];

        nativeBuildInputs = [ pkgs.makeBinaryWrapper ];

        buildPhase = ''
          runHook preBuild

          npx tsgo -p packages/ai/tsconfig.build.json
          npx tsgo -p packages/tui/tsconfig.build.json
          npx tsgo -p packages/agent/tsconfig.build.json
          npm run build --workspace=packages/coding-agent

          runHook postBuild
        '';

        postInstall = ''
          local nm="$out/lib/node_modules/pi-monorepo/node_modules"

          for ws in @earendil-works/pi-ai:packages/ai \
                    @earendil-works/pi-agent-core:packages/agent \
                    @earendil-works/pi-tui:packages/tui; do
            IFS=: read -r pkg src <<< "$ws"
            rm "$nm/$pkg"
            cp -r "$src" "$nm/$pkg"
          done

          find "$nm" -type l -lname '*/packages/*' -delete
          find "$nm/.bin" -xtype l -delete
        ''
        + pkgs.lib.optionalString pkgs.stdenvNoCC.hostPlatform.isDarwin ''
          rm -rf \
            "$nm/@anthropic-ai/sandbox-runtime/dist/vendor/seccomp" \
            "$nm/@anthropic-ai/sandbox-runtime/vendor/seccomp"
        '';

        postFixup = ''
          wrapProgram $out/bin/pi --prefix PATH : ${
            pkgs.lib.makeBinPath [
              pkgs.ripgrep
              pkgs.fd
            ]
          } \
            --set-default PI_SKIP_VERSION_CHECK 1 \
            --set-default PI_TELEMETRY 0
        '';

        doInstallCheck = true;
        nativeInstallCheckInputs = [
          pkgs.writableTmpDirAsHomeHook
          pkgs.versionCheckHook
        ];
        versionCheckKeepEnvironment = [ "HOME" ];
        versionCheckProgram = "${placeholder "out"}/bin/pi";
        versionCheckProgramArg = "--version";
      };

      # pi-acp is a published external adapter. Package exactly the adapter and
      # its two runtime dependencies; no in-repository TypeScript source, npm
      # lock, extension bundle, or TypeScript build toolchain is needed.
      piAcpTarball = pkgs.fetchurl {
        url = "https://registry.npmjs.org/pi-acp/-/pi-acp-0.0.32.tgz";
        hash = "sha512-2/0dfoVhkDTHDQ0R8wwb1ykwlSJm46VEoUyMllzc9hNbEuzUleZXqUwzGScf6+GvepU/4qA4v7hRgGTLgFp5Mw==";
      };
      acpSdkTarball = pkgs.fetchurl {
        url = "https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-0.26.0.tgz";
        hash = "sha512-ialrcI+RzKOYe+fw+TfpyTdRmEoqIkXLlwbTi6XgaXXfdhNcdod7TmE1VsTnG3yTlox8TMTSMQgWbLLbz3r86Q==";
      };
      zodTarball = pkgs.fetchurl {
        url = "https://registry.npmjs.org/zod/-/zod-3.25.76.tgz";
        hash = "sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==";
      };

      piAcpPackage =
        pkgs.runCommand "pi-acp-package"
          {
            nativeBuildInputs = [
              pkgs.gnutar
              pkgs.gzip
            ];
          }
          ''
            mkdir -p "$out" "$out/node_modules/@agentclientprotocol/sdk" "$out/node_modules/zod"
            tar -xzf ${piAcpTarball} --strip-components=1 -C "$out"
            tar -xzf ${acpSdkTarball} --strip-components=1 -C "$out/node_modules/@agentclientprotocol/sdk"
            tar -xzf ${zodTarball} --strip-components=1 -C "$out/node_modules/zod"
          '';

      piAcp = pkgs.writeShellApplication {
        name = "pi-acp";
        runtimeInputs = [
          pkgs.nodejs
          piCodingAgent
        ];
        text = ''
          export PI_ACP_PI_COMMAND="${piCodingAgent}/bin/pi"
          export PI_SKIP_VERSION_CHECK=1
          export PI_TELEMETRY=0
          exec "${pkgs.nodejs}/bin/node" "${piAcpPackage}/dist/index.js" "$@"
        '';
      };
    in
    {
      packages = {
        pi-coding-agent = piCodingAgent;
        pi-acp = piAcp;
      };
    };
}
