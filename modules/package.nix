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

      piDir = ../pi;
      piExtensionsDir = piDir + "/extensions";
      routingConfigYaml = ../routing-config.yaml;

      agentComm = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-agent-comm";
        version = "0.1.0";

        src = ../.;
        cargoLock.lockFile = ../Cargo.lock;

        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [ pkgs.sqlite ];
      };

      catppuccinMochaTheme = pkgs.writeText "catppuccin-mocha.json" (
        builtins.toJSON {
          "$schema" =
            "https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json";
          name = "catppuccin-mocha";

          vars = {
            rosewater = "#f5e0dc";
            flamingo = "#f2cdcd";
            pink = "#f5c2e7";
            mauve = "#cba6f7";
            red = "#f38ba8";
            maroon = "#eba0ac";
            peach = "#fab387";
            yellow = "#f9e2af";
            green = "#a6e3a1";
            teal = "#94e2d5";
            sky = "#89dceb";
            sapphire = "#74c7ec";
            blue = "#89b4fa";
            lavender = "#b4befe";
            text = "#cdd6f4";
            subtext1 = "#bac2de";
            subtext0 = "#a6adc8";
            overlay2 = "#9399b2";
            overlay1 = "#7f849c";
            overlay0 = "#6c7086";
            surface2 = "#585b70";
            surface1 = "#45475a";
            surface0 = "#313244";
            base = "#1e1e2e";
            mantle = "#181825";
            crust = "#11111b";
          };

          colors = {
            accent = "mauve";
            border = "surface1";
            borderAccent = "mauve";
            borderMuted = "surface0";

            success = "green";
            error = "red";
            warning = "yellow";
            muted = "overlay1";
            dim = "overlay0";

            text = "text";
            thinkingText = "subtext0";

            selectedBg = "surface0";
            userMessageBg = "mantle";
            userMessageText = "text";

            customMessageBg = "surface0";
            customMessageText = "text";
            customMessageLabel = "mauve";

            toolPendingBg = "mantle";
            toolSuccessBg = "#1f2d25";
            toolErrorBg = "#302029";
            toolTitle = "blue";
            toolOutput = "text";

            mdHeading = "mauve";
            mdLink = "blue";
            mdLinkUrl = "sapphire";
            mdCode = "teal";
            mdCodeBlock = "text";
            mdCodeBlockBorder = "surface1";
            mdQuote = "subtext0";
            mdQuoteBorder = "surface1";
            mdHr = "surface1";
            mdListBullet = "mauve";

            toolDiffAdded = "green";
            toolDiffRemoved = "red";
            toolDiffContext = "overlay1";

            syntaxComment = "overlay1";
            syntaxKeyword = "mauve";
            syntaxFunction = "blue";
            syntaxVariable = "text";
            syntaxString = "green";
            syntaxNumber = "peach";
            syntaxType = "yellow";
            syntaxOperator = "sky";
            syntaxPunctuation = "overlay2";

            thinkingOff = "surface1";
            thinkingMinimal = "blue";
            thinkingLow = "sky";
            thinkingMedium = "teal";
            thinkingHigh = "mauve";
            thinkingXhigh = "pink";

            bashMode = "peach";
          };
        }
      );

      piPackageManifest = {
        name = "@matthis-k/phenix-pi";
        version = "0.1.0";
        private = false;
        description = "Phenix workflow resources, provider router, read-only LSP tools, and Catppuccin theme for Pi.";

        keywords = [
          "pi-package"
          "phenix"
          "router"
          "lsp"
          "theme"
        ];

        pi = {
          extensions = [ "./pi/extensions" ];
          skills = [ "./pi/skills" ];
          prompts = [ "./pi/prompts" ];
          themes = [ "./pi/themes" ];
        };

        peerDependencies = {
          "@earendil-works/pi-ai" = "*";
          "@earendil-works/pi-agent-core" = "*";
          "@earendil-works/pi-coding-agent" = "*";
          "@earendil-works/pi-tui" = "*";
          typebox = "*";
        };
      };

      generatedPiPackageJson = pkgs.writeText "phenix-pi-package.json" (
        builtins.toJSON piPackageManifest
      );

      piPackageRoot = pkgs.runCommand "phenix-pi-package" { } ''
        mkdir -p $out/pi

        cp ${generatedPiPackageJson} $out/package.json

        cp -R ${piDir}/extensions $out/pi/extensions
        cp -R ${piDir}/prompts $out/pi/prompts
        cp -R ${piDir}/skills $out/pi/skills

        mkdir -p $out/pi/themes
        cp ${catppuccinMochaTheme} $out/pi/themes/catppuccin-mocha.json
      '';

      piSettings = {
        defaultProjectTrust = "ask";
        enableInstallTelemetry = false;
        enableAnalytics = false;

        theme = "catppuccin-mocha";

        # Load Phenix resources as a local Pi package.
        # This does not replace Pi's runtime package root.
        packages = [ "${piPackageRoot}" ];
      };

      generatedPiSettings = pkgs.writeText "phenix-pi-settings.json" (builtins.toJSON piSettings);

      routingConfigPackage = pkgs.runCommand "phenix-agent-routing-config" { } ''
        mkdir -p $out/share/phenix-agent-harness
        cp ${routingConfigYaml} $out/share/phenix-agent-harness/routing-config.yaml
      '';

      wrappedPi = wrapperModule.wrap {
        inherit pkgs;

        package = pkgs.pi-coding-agent;

        pi = {
          codingAgentDir = "~/.config/phenix-pi";
          managedSettings = generatedPiSettings;
          managedConfig = true;

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
        pi-package = piPackageRoot;
        agent-comm = agentComm;
        routing-config = routingConfigPackage;

        generated-pi-settings = generatedPiSettings;
        generated-pi-package-json = generatedPiPackageJson;
        catppuccin-pi-theme = catppuccinMochaTheme;
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

        generated-pi-resources =
          pkgs.runCommand "phenix-pi-generated-resources-check"
            {
              nativeBuildInputs = [
                pkgs.jq
                pkgs.gnugrep
              ];
            }
            ''
              jq -e '.theme == "catppuccin-mocha"' ${generatedPiSettings}
              jq -e '.enableInstallTelemetry == false' ${generatedPiSettings}
              jq -e '.enableAnalytics == false' ${generatedPiSettings}
              jq -e '.packages | type == "array" and length == 1' ${generatedPiSettings}
              jq -e '.packages[0] | test("phenix-pi-package")' ${generatedPiSettings}

              jq -e 'has("extensions") | not' ${generatedPiSettings}
              jq -e 'has("skills") | not' ${generatedPiSettings}
              jq -e 'has("prompts") | not' ${generatedPiSettings}
              jq -e 'has("themes") | not' ${generatedPiSettings}

              jq -e '.pi.extensions == ["./pi/extensions"]' ${generatedPiPackageJson}
              jq -e '.pi.skills == ["./pi/skills"]' ${generatedPiPackageJson}
              jq -e '.pi.prompts == ["./pi/prompts"]' ${generatedPiPackageJson}
              jq -e '.pi.themes == ["./pi/themes"]' ${generatedPiPackageJson}

              jq -e '.peerDependencies."@earendil-works/pi-coding-agent" == "*"' ${generatedPiPackageJson}
              jq -e '.peerDependencies."@earendil-works/pi-ai" == "*"' ${generatedPiPackageJson}
              jq -e '.peerDependencies."@earendil-works/pi-agent-core" == "*"' ${generatedPiPackageJson}
              jq -e '.peerDependencies."@earendil-works/pi-tui" == "*"' ${generatedPiPackageJson}
              jq -e '.dependencies | not' ${generatedPiPackageJson}

              test -e ${piPackageRoot}/package.json
              test -e ${piPackageRoot}/pi/extensions/lsp.ts
              test -e ${piPackageRoot}/pi/extensions/phenix-router.ts
              test -d ${piPackageRoot}/pi/prompts
              test -d ${piPackageRoot}/pi/skills
              test -e ${piPackageRoot}/pi/themes/catppuccin-mocha.json

              jq -e '.name == "catppuccin-mocha"' ${piPackageRoot}/pi/themes/catppuccin-mocha.json
              jq -e '.colors.accent == "mauve"' ${piPackageRoot}/pi/themes/catppuccin-mocha.json
              jq -e '.colors.bashMode == "peach"' ${piPackageRoot}/pi/themes/catppuccin-mocha.json

              grep -F -q 'PI_PACKAGE_DIR' ${wrappedPi}/bin/pi
              grep -F -q '/lib/node_modules/pi-monorepo' ${wrappedPi}/bin/pi
              ! grep -F -q '.cache/phenix-pi/packages' ${wrappedPi}/bin/pi
              ! grep -F -q 'export PI_PACKAGE_DIR="''${PI_PACKAGE_DIR:-$HOME/.cache/phenix-pi/packages}"' ${wrappedPi}/bin/pi

              grep -F -q 'PHENIX_PI_MANAGED_CONFIG' ${wrappedPi}/bin/pi
              grep -F -q '${generatedPiSettings}' ${wrappedPi}/bin/pi

              grep -F -q 'name: "lsp_diagnostics"' ${piExtensionsDir}/lsp.ts
              grep -F -q 'name: "lsp_hover"' ${piExtensionsDir}/lsp.ts
              grep -F -q 'read-only' ${piExtensionsDir}/lsp.ts
              ! grep -E -q 'codeAction|rename|workspace/applyEdit' ${piExtensionsDir}/lsp.ts

              grep -F -q 'pi.registerProvider(PHENIX_PROVIDER' ${piExtensionsDir}/phenix-router.ts
              grep -F -q 'pi.registerCommand("router"' ${piExtensionsDir}/phenix-router.ts
              grep -F -q 'phenix-router.routes.json' ${piExtensionsDir}/phenix-router.ts
              ! grep -F -q 'setModel(' ${piExtensionsDir}/phenix-router.ts

              touch $out
            '';

        wrapped-pi-smoke =
          pkgs.runCommand "phenix-pi-wrapper-smoke-test"
            {
              nativeBuildInputs = [
                wrappedPi
                pkgs.gnugrep
              ];
            }
            ''
              grep -F -q 'PI_PACKAGE_DIR' ${wrappedPi}/bin/pi
              grep -F -q '/lib/node_modules/pi-monorepo' ${wrappedPi}/bin/pi
              ! grep -F -q '.cache/phenix-pi/packages' ${wrappedPi}/bin/pi

              touch $out
            '';
      };
    };
}
