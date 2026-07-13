_:

{
  perSystem =
    { pkgs, ... }:
    let
      tooling = import ./tooling.nix { inherit pkgs; };
      piNpmRoot = ./pi-npm;

      # package-lock.json is the sole dependency authority. importNpmLock
      # resolves every registry or Git dependency from its recorded integrity
      # hash or commit without a repository-wide fixed-output hash.
      #
      # Pi packages are peers of the extension packages but are supplied from
      # pkgs.pi-coding-agent below. The lockfile is therefore generated and
      # installed with legacy-peer-deps so npm does not duplicate Pi and its
      # shrinkwrap graph.
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

        # Nix packages Pi as a monorepo root plus workspace dependencies. Expose
        # the three packages imported directly by Phenix without duplicating the
        # monorepo's transitive dependency tree.
        piRoot=${pkgs.pi-coding-agent}/lib/node_modules/pi-monorepo
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

      qualityTools = tooling.quality;

      phenixRepositoryChecks =
        pkgs.runCommand "phenix-repository-checks"
          {
            nativeBuildInputs = qualityTools ++ [ pkgs.bash ];
          }
          ''
            bash -n \
              ${../scripts/check.sh} \
              ${../scripts/check-files.sh} \
              ${../scripts/check-all-files.sh} \
              ${../scripts/check-runtime-direct.sh} \
              ${../scripts/fix-staged.sh} \
              ${../scripts/setup-git-hooks.sh} \
              ${../.githooks/pre-commit} \
              ${../.githooks/pre-push}
            shellcheck \
              ${../scripts/check.sh} \
              ${../scripts/check-files.sh} \
              ${../scripts/check-all-files.sh} \
              ${../scripts/check-runtime-direct.sh} \
              ${../scripts/fix-staged.sh} \
              ${../scripts/setup-git-hooks.sh} \
              ${../.githooks/pre-commit} \
              ${../.githooks/pre-push}
            shfmt -d -i 2 -ci \
              ${../scripts/check.sh} \
              ${../scripts/check-files.sh} \
              ${../scripts/check-all-files.sh} \
              ${../scripts/check-runtime-direct.sh} \
              ${../scripts/fix-staged.sh} \
              ${../scripts/setup-git-hooks.sh} \
              ${../.githooks/pre-commit} \
              ${../.githooks/pre-push}
            actionlint ${../.github/workflows/ci.yml}
            biome ci \
              --config-path ${../biome.json} \
              --no-errors-on-unmatched \
              --files-ignore-unknown=true \
              ${../biome.json} \
              ${../.tend.json}
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

      updatePiNpmLock = pkgs.writeShellApplication {
        name = "update-pi-npm-lock";
        runtimeInputs = [ pkgs.nodejs ];
        text = ''
          if [[ ! -f modules/pi-npm/package.json ]]; then
            echo "run this command from the phenix-agent-harness repository root" >&2
            exit 1
          fi

          npm install \
            --prefix modules/pi-npm \
            --package-lock-only \
            --ignore-scripts \
            --legacy-peer-deps \
            --no-audit \
            --no-fund

          echo "Updated modules/pi-npm/package-lock.json"
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
        update-pi-npm-lock = updatePiNpmLock;
      };

      checks = {
        phenix-pi-npm-packages = piNpmPackages;
        phenix-runtime-tests = phenixRuntimeTests;
        phenix-typecheck = phenixTypecheck;
        phenix-repository-checks = phenixRepositoryChecks;
      };
    };
}
