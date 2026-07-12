{ lib, ... }:

{
  perSystem =
    { pkgs, ... }:
    let
      piNpmPackageSpecs = {
        "@hypabolic/pi-hypa" = "npm:@hypabolic/pi-hypa@0.1.10";
        "@juicesharp/rpiv-web-tools" = "npm:@juicesharp/rpiv-web-tools@1.20.0";
        "pi-context-tools" = "npm:pi-context-tools@0.1.1";
        "pi-lsp" = "npm:pi-lsp@0.1.7";
        "pi-mcp-adapter" = "npm:pi-mcp-adapter@2.11.0";
        "typebox" = "npm:typebox@1.1.24";
      };

      # Bootstrap or refresh with:
      #   nix run .#update-pi-npm-hash
      # Intentionally fake after adding packages. Run `nix run .#update-pi-npm-hash`.
      piNpmHash = "sha256-XvCLcnzVf/ng42vNuv1qksEocKRBIAUhYqa68tGr0Ec=";

      piNpmPackages = import ./lib/mk-pi-npm-packages.nix {
        inherit lib pkgs;
        pi = pkgs.pi-coding-agent;
        packages = piNpmPackageSpecs;
        hash = piNpmHash;
      };

      phenixPiPackage = pkgs.runCommand "phenix-pi-package" { } ''
        mkdir -p "$out"
        cp -R ${./phenix-pi}/. "$out/"
        chmod -R u+w "$out"

        rm -rf "$out/node_modules"
        cp -R ${piNpmPackages}/npm/node_modules "$out/node_modules"
        chmod -R u+w "$out/node_modules"

        # Pi is supplied by Nix rather than installed into the fixed-output npm
        # set. Expose the directly imported Pi packages to TypeScript and Node
        # through the same package-local node_modules tree.
        mkdir -p "$out/node_modules/@earendil-works"
        for package in pi-coding-agent pi-agent-core pi-ai; do
          source=${pkgs.pi-coding-agent}/lib/node_modules/@earendil-works/$package
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

      qualityTools = [
        pkgs.actionlint
        pkgs.biome
        pkgs.coreutils
        pkgs.diffutils
        pkgs.git
        pkgs.gnugrep
        pkgs.nixfmt
        pkgs.shellcheck
        pkgs.shfmt
        pkgs.statix
      ];

      phenixRepositoryChecks =
        pkgs.runCommand "phenix-repository-checks"
          {
            nativeBuildInputs = qualityTools ++ [ pkgs.bash ];
          }
          ''
            bash -n \
              ${../scripts/check.sh} \
              ${../scripts/check-files.sh} \
              ${../scripts/fix-staged.sh} \
              ${../scripts/setup-git-hooks.sh} \
              ${../.githooks/pre-commit} \
              ${../.githooks/pre-push}
            shellcheck \
              ${../scripts/check.sh} \
              ${../scripts/check-files.sh} \
              ${../scripts/fix-staged.sh} \
              ${../scripts/setup-git-hooks.sh} \
              ${../.githooks/pre-commit} \
              ${../.githooks/pre-push}
            shfmt -d -i 2 -ci \
              ${../scripts/check.sh} \
              ${../scripts/check-files.sh} \
              ${../scripts/fix-staged.sh} \
              ${../scripts/setup-git-hooks.sh} \
              ${../.githooks/pre-commit} \
              ${../.githooks/pre-push}
            actionlint ${../.github/workflows/ci.yml}
            biome ci \
              --config-path ${../biome.json} \
              --no-errors-on-unmatched \
              --files-ignore-unknown=true \
              ${../biome.json}
            touch "$out"
          '';

      phenixCheck = pkgs.writeShellApplication {
        name = "phenix-check";
        runtimeInputs = qualityTools ++ [
          pkgs.bash
          pkgs.nix
        ];
        text = ''
          exec bash ${../scripts/check.sh} "$@"
        '';
      };

      phenixFixStaged = pkgs.writeShellApplication {
        name = "phenix-fix-staged";
        runtimeInputs = qualityTools ++ [
          pkgs.bash
          pkgs.nix
        ];
        text = ''
          exec bash ${../scripts/fix-staged.sh} "$@"
        '';
      };

      setupGitHooks = pkgs.writeShellApplication {
        name = "setup-git-hooks";
        runtimeInputs = [
          pkgs.coreutils
          pkgs.git
        ];
        text = ''
          exec bash ${../scripts/setup-git-hooks.sh}
        '';
      };

      updatePiNpmHash = pkgs.writeShellApplication {
        name = "update-pi-npm-hash";
        runtimeInputs = [
          pkgs.nix
          pkgs.coreutils
          pkgs.gnused
        ];

        text = ''
          if [[ ! -f modules/pi-packages.nix ]]; then
            echo "run this command from the phenix-agent-harness repository root" >&2
            exit 1
          fi

          set +e
          build_log="$(nix build --no-link .#phenix-pi-npm-packages 2>&1)"
          build_status=$?
          set -e

          if [[ $build_status -eq 0 ]]; then
            echo "Pi npm package hash is already valid."
            exit 0
          fi

          got_hash="$(
            printf '%s\n' "$build_log" \
              | sed -nE 's/^[[:space:]]*got:[[:space:]]*(sha256-[^[:space:]]+).*$/\1/p' \
              | tail -n 1
          )"

          if [[ -z "$got_hash" ]]; then
            printf '%s\n' "$build_log" >&2
            echo "could not extract the fixed-output hash" >&2
            exit "$build_status"
          fi

          sed -i -E \
            's|^      piNpmHash = .*;|      piNpmHash = "'"$got_hash"'";|' \
            modules/pi-packages.nix

          echo "Updated piNpmHash to $got_hash"
        '';
      };
    in
    {
      packages = {
        phenix-pi-package = phenixPiPackage;
        phenix-shell = phenixPiPackage;
        phenix-pi-npm-packages = piNpmPackages;
        phenix-runtime-tests = phenixRuntimeTests;
        phenix-typecheck = phenixTypecheck;
        phenix-repository-checks = phenixRepositoryChecks;
        phenix-check = phenixCheck;
        phenix-fix-staged = phenixFixStaged;
        setup-git-hooks = setupGitHooks;
        update-pi-npm-hash = updatePiNpmHash;
      };

      checks = {
        phenix-pi-npm-packages = piNpmPackages;
        phenix-runtime-tests = phenixRuntimeTests;
        phenix-typecheck = phenixTypecheck;
        phenix-repository-checks = phenixRepositoryChecks;
      };
    };
}
