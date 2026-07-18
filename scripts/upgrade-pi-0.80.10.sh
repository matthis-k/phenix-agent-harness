#!/usr/bin/env bash
set -euo pipefail

python3 <<'PY'
from pathlib import Path

flake = Path("flake.nix")
text = flake.read_text()
needle = '    nixpkgs.follows = "phenix-pins/nixpkgs";\n'
addition = '''    nixpkgs.follows = "phenix-pins/nixpkgs";

    pi-src = {
      url = "github:earendil-works/pi/v0.80.10";
      flake = false;
    };
'''
if "pi-src" not in text:
    if needle not in text:
        raise SystemExit("flake.nix insertion point not found")
    text = text.replace(needle, addition, 1)
    flake.write_text(text)

standalone = Path("modules/standalone.nix")
text = standalone.read_text()
old = 'exec "${pkgs.pi-coding-agent}/bin/pi" \\\n'
new = 'exec "${self\'.packages.pi-coding-agent}/bin/pi" \\\n'
if old not in text and new not in text:
    raise SystemExit("standalone Pi executable reference not found")
standalone.write_text(text.replace(old, new, 1))

sdk = Path("modules/phenix-pi/extensions/phenix-runtime/sdk-child-session-backend.ts")
text = sdk.read_text()
replacements = [
    (
        "  readonly modelRegistry: ModelRegistry;\n  readonly thinkingLevel: ThinkingLevel;",
        "  readonly agentDir: string;\n  readonly thinkingLevel: ThinkingLevel;",
    ),
    (
        "      modelRegistry: spec.modelRegistry,\n      thinkingLevel: spec.thinkingLevel,",
        "      agentDir: spec.agentDir,\n      thinkingLevel: spec.thinkingLevel,",
    ),
    (
        "      model,\n      modelRegistry,\n      thinkingLevel: spec.thinkingLevel,",
        "      model,\n      agentDir: this.services.agentDir,\n      thinkingLevel: spec.thinkingLevel,",
    ),
]
for old, new in replacements:
    if old not in text and new not in text:
        raise SystemExit(f"SDK migration pattern not found: {old!r}")
    text = text.replace(old, new, 1)
sdk.write_text(text)
PY

cat > modules/pi-packages.nix <<'NIX'
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

        npmDepsHash = pkgs.lib.fakeHash;
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

        piRoot=${piCodingAgent}/lib/node_modules/pi-monorepo
        mkdir -p "$out/node_modules/@earendil-works"
        ln -s "$piRoot" "$out/node_modules/@earendil-works/pi-coding-agent"
        for package in pi-agent-core pi-ai; do
          source="$piRoot/node_modules/@earendil-works/$package"
          test -e "$source"
          rm -rf "$out/node_modules/@earendil-works/$package"
          ln -s "$source" "$out/node_modules/@earendil-works/$package"
        done
      '';

      phenixRuntimeTests =
        pkgs.runCommand "phenix-runtime-tests"
          {
            nativeBuildInputs = [
              pkgs.nodejs
              pkgs.ast-grep
              pkgs.git
            ];
          }
          ''
            cd ${phenixPiPackage}
            node --experimental-strip-types --test tests/*.test.ts
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
NIX

nix flake lock --update-input pi-src

set +e
nix build .#pi-coding-agent --no-link > /tmp/pi-first-build.log 2>&1
first_status=$?
set -e

if [[ $first_status -ne 0 ]]; then
  dependency_hash=$(sed -n 's/.*got:[[:space:]]*\(sha256-[^[:space:]]*\).*/\1/p' /tmp/pi-first-build.log | tail -n 1)
  if [[ -z "$dependency_hash" ]]; then
    cat /tmp/pi-first-build.log
    exit "$first_status"
  fi

  python3 - "$dependency_hash" <<'PY'
from pathlib import Path
import sys
path = Path("modules/pi-packages.nix")
text = path.read_text()
marker = "npmDepsHash = pkgs.lib.fakeHash;"
if marker not in text:
    raise SystemExit("fake npm dependency hash marker not found")
path.write_text(text.replace(marker, f'npmDepsHash = "{sys.argv[1]}";', 1))
PY
fi

nix build .#pi-coding-agent .#phenix-typecheck .#phenix-runtime-tests .#pi --no-link

rm -f \
  .github/workflows/upgrade-pi.yml \
  .github/workflows/upgrade-pi-pr.yml \
  scripts/upgrade-pi-0.80.10.sh

git config user.name github-actions[bot]
git config user.email 41898282+github-actions[bot]@users.noreply.github.com
git add -A
git commit -m "fix(pi): pin official Pi 0.80.10 source"
git push origin HEAD:fix/upgrade-pi-0.80.10
