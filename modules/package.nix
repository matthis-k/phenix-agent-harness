{ inputs, ... }:
{
  perSystem =
    {
      pkgs,
      system,
      ...
    }:
    let
      lib = pkgs.lib;

      codebase-memory-mcp = inputs.nixpkgs-unstable.legacyPackages.${system}.codebase-memory-mcp;

      inherit (pkgs) github-mcp-server;

      mcp-nixos = inputs.nixpkgs-unstable.legacyPackages.${system}.mcp-nixos;

      context7-mcp = inputs.nixpkgs-unstable.legacyPackages.${system}.context7-mcp;

      wrapperModule = (inputs.nix-wrapper-modules.lib.evalModule (import ./wrapper-module.nix)).config;

      routingConfigYaml = ../routing-config.yaml;

      agentComm = import ./agent_comm_mcp/package.nix { inherit pkgs; };

      phenixPiConfigDir = pkgs.runCommand "phenix-pi-config-dir" { } ''
        cp -r ${../config/phenix-pi} $out
      '';

      routingConfigPackage = pkgs.runCommand "phenix-agent-routing-config" { } ''
        mkdir -p $out/share/phenix-agent-harness
        cp ${routingConfigYaml} $out/share/phenix-agent-harness/routing-config.yaml
      '';

      wrappedPi = wrapperModule.wrap {
        inherit pkgs;

        package = pkgs.pi-coding-agent;

        pi = {
          configDir = phenixPiConfigDir;
          stateDir = null;

          theme = "catppuccin-mocha";
          managedConfig = true;

          loadConfigDirAsPackage = true;
          directResourceCompat = false;

          skipVersionCheck = true;
          telemetry = false;

          extraPackages = [
            pkgs.nil
            pkgs.typescript-language-server
            pkgs.nodejs
            pkgs.jq
            pkgs.ripgrep
            pkgs.fd
            agentComm
            inputs.phenix-tend.packages.${system}."tend"
            inputs.phenix-tend.packages.${system}."tend-mcp"
            inputs.phenix-stitch.packages.${system}."stitch"
            inputs.phenix-stitch.packages.${system}."stitch-mcp"
            codebase-memory-mcp
            github-mcp-server
            mcp-nixos
            context7-mcp
          ];
        };
      };
    in
    {
      packages = {
        default = wrappedPi;

        pi = wrappedPi;
        phenix-pi-config-dir = phenixPiConfigDir;
        agent-comm = agentComm;
        routing-config = routingConfigPackage;
      };

      checks = {
        agent-comm = agentComm;

        agent-comm-smoke =
          pkgs.runCommand "phenix-agent-comm-smoke-test"
            {
              nativeBuildInputs = [
                agentComm
                pkgs.jq
              ];
            }
            ''
              echo "=== agent-comm init smoke test ==="
              DB=$(mktemp)

              ${agentComm}/bin/phenix-agent-comm-mcp init --db "$DB" > /dev/null 2>&1 || {
                echo "FAIL: agent-comm init boot failed"
                exit 1
              }

              echo "init: OK"

              echo "=== agent-comm tool call smoke test ==="
              TOOL_OUT=$(${agentComm}/bin/phenix-agent-comm-mcp tool \
                comm_session_init \
                --args '{"name":"smoke-test"}' \
                --db "$DB" 2>&1) || {
                echo "FAIL: agent-comm tool call failed"
                echo "$TOOL_OUT"
                exit 1
              }

              echo "$TOOL_OUT" | jq -e '.status == "open"' > /dev/null 2>&1 || {
                echo "FAIL: session status is not open"
                echo "$TOOL_OUT"
                exit 1
              }

              echo "tool call: OK"

              echo "=== session list smoke test ==="
              LIST_OUT=$(${agentComm}/bin/phenix-agent-comm-mcp tool \
                comm_session_list \
                --args '{}' \
                --db "$DB" 2>&1) || {
                echo "FAIL: agent-comm session list failed"
                echo "$LIST_OUT"
                exit 1
              }

              echo "$LIST_OUT" | jq -e 'type == "array"' > /dev/null 2>&1 || {
                echo "FAIL: session list did not return an array"
                echo "$LIST_OUT"
                exit 1
              }

              echo "session list: OK"

              rm -f "$DB"
              touch $out
            '';

        phenix-pi-config-dir-check =
          pkgs.runCommand "phenix-pi-config-dir-check"
            {
              nativeBuildInputs = [
                pkgs.jq
                pkgs.gnugrep
              ];
            }
            ''
              test -e ${phenixPiConfigDir}/package.json
              test -e ${phenixPiConfigDir}/pi/extensions/lsp.ts
              test -e ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              test -d ${phenixPiConfigDir}/pi/prompts
              test -d ${phenixPiConfigDir}/pi/skills
              test -e ${phenixPiConfigDir}/pi/themes/catppuccin-mocha.json

              jq -e '.name == "catppuccin-mocha"' ${phenixPiConfigDir}/pi/themes/catppuccin-mocha.json
              jq -e '.colors.accent == "mauve"' ${phenixPiConfigDir}/pi/themes/catppuccin-mocha.json
              jq -e '.colors.bashMode == "peach"' ${phenixPiConfigDir}/pi/themes/catppuccin-mocha.json

              jq -e '.pi.extensions == ["./pi/extensions"]' ${phenixPiConfigDir}/package.json
              jq -e '.pi.skills == ["./pi/skills"]' ${phenixPiConfigDir}/package.json
              jq -e '.pi.prompts == ["./pi/prompts"]' ${phenixPiConfigDir}/package.json
              jq -e '.pi.themes == ["./pi/themes"]' ${phenixPiConfigDir}/package.json

              jq -e '.peerDependencies."@earendil-works/pi-coding-agent" == "*"' ${phenixPiConfigDir}/package.json
              jq -e '.peerDependencies."@earendil-works/pi-ai" == "*"' ${phenixPiConfigDir}/package.json
              jq -e '.peerDependencies."@earendil-works/pi-agent-core" == "*"' ${phenixPiConfigDir}/package.json
              jq -e '.peerDependencies."@earendil-works/pi-tui" == "*"' ${phenixPiConfigDir}/package.json
              jq -e '.dependencies | not' ${phenixPiConfigDir}/package.json

              grep -F -q 'name: "lsp_diagnostics"' ${phenixPiConfigDir}/pi/extensions/lsp.ts
              grep -F -q 'name: "lsp_hover"' ${phenixPiConfigDir}/pi/extensions/lsp.ts
              grep -F -q 'read-only' ${phenixPiConfigDir}/pi/extensions/lsp.ts
              ! grep -E -q 'codeAction|rename|workspace/applyEdit' ${phenixPiConfigDir}/pi/extensions/lsp.ts

              grep -F -q 'pi.registerProvider(PHENIX_PROVIDER' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              grep -F -q 'pi.registerCommand("router"' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              grep -F -q 'phenix-router.routes.json' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              ! grep -F -q 'setModel(' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts

              touch $out
            '';

        wrapped-pi-check =
          pkgs.runCommand "phenix-pi-wrapper-check"
            {
              nativeBuildInputs = [
                wrappedPi
                pkgs.jq
                pkgs.gnugrep
              ];
            }
            ''
              grep -F -q 'PI_PACKAGE_DIR' ${wrappedPi}/bin/pi
              grep -F -q '/lib/node_modules/pi-monorepo' ${wrappedPi}/bin/pi
              ! grep -F -q '.cache/phenix-pi/packages' ${wrappedPi}/bin/pi
              ! grep -F -q 'export PI_PACKAGE_DIR="''${PI_PACKAGE_DIR:-$HOME/.cache/phenix-pi/packages}"' ${wrappedPi}/bin/pi

              grep -F -q 'XDG_STATE_HOME' ${wrappedPi}/bin/pi
              grep -F -q '.local/state}/phenix-pi' ${wrappedPi}/bin/pi

              grep -F -q 'PHENIX_PI_MANAGED_CONFIG' ${wrappedPi}/bin/pi
              grep -F -q 'phenix-pi-settings.json' ${wrappedPi}/bin/pi

              ! grep -F -q 'PI_SOPS' ${wrappedPi}/bin/pi
              ! grep -F -q 'PI_SECRET' ${wrappedPi}/bin/pi

              SETTINGS_PATH=$(grep -o '/nix/store/[a-z0-9]*-phenix-pi-settings\.json' ${wrappedPi}/bin/pi | head -1)
              if [ -n "$SETTINGS_PATH" ] && [ -f "$SETTINGS_PATH" ]; then
                jq -e '.packages | type == "array" and length == 1' "$SETTINGS_PATH"
                jq -e '.packages[0] | test("phenix-pi-config-dir")' "$SETTINGS_PATH"
                jq -e '.theme == "catppuccin-mocha"' "$SETTINGS_PATH"
                jq -e '.enableInstallTelemetry == false' "$SETTINGS_PATH"
                jq -e '.enableAnalytics == false' "$SETTINGS_PATH"
                jq -e 'has("extensions") | not' "$SETTINGS_PATH"
                jq -e 'has("skills") | not' "$SETTINGS_PATH"
                jq -e 'has("prompts") | not' "$SETTINGS_PATH"
                jq -e 'has("themes") | not' "$SETTINGS_PATH"
              fi

              touch $out
            '';
      };
    };
}
