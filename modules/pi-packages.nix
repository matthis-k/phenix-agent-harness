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
      piNpmPackages = pkgs.importNpmLock.buildNodeModules {
        npmRoot = piNpmRoot;
        inherit (pkgs) nodejs;
        derivationArgs = {
          pname = "phenix-pi-npm-packages";
          version = "2.0.0";
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

        piRoot=${piCodingAgent}/lib/node_modules/pi-monorepo
        mkdir -p "$out/node_modules/@earendil-works" "$out/node_modules/@types"
        ln -s "$piRoot" "$out/node_modules/@earendil-works/pi-coding-agent"
        ln -s "$piRoot/node_modules/@types/node" "$out/node_modules/@types/node"
        ln -s "$piRoot/node_modules/undici-types" "$out/node_modules/undici-types"
        for package in pi-agent-core pi-ai pi-tui; do
          source="$piRoot/node_modules/@earendil-works/$package"
          test -e "$source"
          rm -rf "$out/node_modules/@earendil-works/$package"
          ln -s "$source" "$out/node_modules/@earendil-works/$package"
        done
      '';

      phenixRuntimeTests =
        pkgs.runCommand "phenix-runtime-tests"
          {
            nativeBuildInputs = [ pkgs.nodejs ];
          }
          ''
            cd ${phenixPiPackage}
            node --experimental-strip-types --test tests/*.test.ts
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
        phenix-pi-npm-packages = piNpmPackages;
        phenix-runtime-tests = phenixRuntimeTests;
        phenix-typecheck = phenixTypecheck;
      };
    };
}
