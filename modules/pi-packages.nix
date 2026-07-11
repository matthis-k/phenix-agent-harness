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
        "pi-subagents" = "npm:pi-subagents@0.34.0";
        "typebox" = "npm:typebox@1.1.24";
      };

      # Bootstrap or refresh with:
      #   nix run .#update-pi-npm-hash
      # Intentionally fake after adding packages. Run `nix run .#update-pi-npm-hash`.
      piNpmHash = "sha256-ac1/3HJL+J277cZRZ3wgI/xPyH6kAG/qTGp8FP62U/s=";

      piNpmPackages = import ./lib/mk-pi-npm-packages.nix {
        inherit lib pkgs;
        pi = pkgs.pi-coding-agent;
        packages = piNpmPackageSpecs;
        hash = piNpmHash;
      };

      # phenix-core.ts imports Hypa, RPIV web tools, context tools, LSP,
      # MCP, pi-subagents, and the typed Phenix runtime directly. The shared
      # npm tree produced by `pi install`
      # therefore belongs beside the Phenix package as its node_modules.
      phenixPiPackage = pkgs.runCommand "phenix-pi-package" { } ''
        mkdir -p "$out"
        cp -R ${./phenix-pi}/. "$out/"
        chmod -R u+w "$out"
        rm -rf "$out/node_modules"
        ln -s ${piNpmPackages}/npm/node_modules "$out/node_modules"
      '';

      phenixSubagentTests = pkgs.runCommand "phenix-subagent-runtime-tests" {
        nativeBuildInputs = [ pkgs.nodejs ];
      } ''
        cd ${phenixPiPackage}
        node --experimental-strip-types --test tests/*.test.ts
        node --check runtime/verify.mjs
        touch "$out"
      '';

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
        phenix-subagent-tests = phenixSubagentTests;
        update-pi-npm-hash = updatePiNpmHash;
      };

      checks = {
        phenix-pi-npm-packages = piNpmPackages;
        phenix-subagent-tests = phenixSubagentTests;
      };
    };
}
