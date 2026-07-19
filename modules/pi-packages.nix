{ inputs, ... }:

{
  perSystem =
    { pkgs, ... }:
    let
      piVersion = "0.80.10";

      # Pi is pinned independently from Nixpkgs. The harness needs both the
      # executable and public SDK packages, so binary-only flakes are not enough.
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

        # Materialize workspace dependencies so external Phenix extensions can
        # import the exact SDK modules used by the packaged Pi executable.
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

      piNpmRoot = ./pi-npm;

      # The extension lock remains independent; Pi is supplied by piCodingAgent.
      piNpmPackages = pkgs.importNpmLock.buildNodeModules {
        npmRoot = piNpmRoot;
        inherit (pkgs) nodejs;
        derivationArgs = {
          pname = "phenix-pi-npm-packages";
          version = "1.0.0";
          npmFlags = [ "--legacy-peer-deps" ];
          npm_config_ignore_scripts = true;
        };
      };

      phenixPiPackage = pkgs.runCommand "phenix-pi-package" { } ''
        mkdir -p "$out"
        cp -R ${./phenix-pi}/. "$out/"
        chmod -R u+w "$out"

        rm -rf "$out/node_modules"
        cp -R ${piNpmPackages}/node_modules "$out/node_modules"
        chmod -R u+w "$out/node_modules"

        mkdir -p "$out/bin"
        test -x "$out/node_modules/.bin/fta"
        ln -s "$out/node_modules/.bin/fta" "$out/bin/fta"

        piRoot=${piCodingAgent}/lib/node_modules/pi-monorepo
        mkdir -p "$out/node_modules/@earendil-works"
        ln -s "$piRoot" "$out/node_modules/@earendil-works/pi-coding-agent"
        for package in pi-agent-core pi-ai; do
          source="$piRoot/node_modules/@earendil-works/$package"
          test -e "$source"
          rm -rf "$out/node_modules/@earendil-works/$package"
          ln -s "$source" "$out/node_modules/@earendil-works/$package"
        done

        mkdir -p "$out/node_modules/@matthis-k"
        for package in phenix-kernel phenix-flow phenix-routing phenix-contracts phenix-tasks phenix-suite; do
          rm -rf "$out/node_modules/@matthis-k/$package"
          ln -s "$out/packages/$package" "$out/node_modules/@matthis-k/$package"
        done
      '';

      phenixRuntimeTests =
        pkgs.runCommand "phenix-runtime-tests"
          {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.ast-grep
              pkgs.git
              pkgs.which
            ];
          }
          ''
            export PATH=${pkgs.lib.makeBinPath [ phenixPiPackage ]}:$PATH
            cd ${phenixPiPackage}
            node --experimental-strip-types --test tests/*.test.ts
            node --check runtime/managed-json.mjs
            node --check runtime/merge-mcp-defaults.mjs
            node --check runtime/merge-model-defaults.mjs
            node --check runtime/verify.mjs
            touch "$out"
          '';

      phenixTypecheck =
        pkgs.runCommand "phenix-typecheck"
          {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.typescript
            ];
          }
          ''
            cd ${phenixPiPackage}
            tsc --project tsconfig.json --pretty false
            touch "$out"
          '';
    in
    {
      packages = {
        pi-coding-agent = piCodingAgent;
        phenix-pi-package = phenixPiPackage;
        phenix-shell = phenixPiPackage;
        phenix-pi-npm-packages = piNpmPackages;
        phenix-runtime-tests = phenixRuntimeTests;
        phenix-typecheck = phenixTypecheck;
      };
    };
}
