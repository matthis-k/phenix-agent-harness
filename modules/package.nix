{ inputs, ... }:
{
  perSystem =
    {
      pkgs,
      system,
      ...
    }:
    let
      inherit (pkgs) lib;

      codebase-memory-mcp = inputs.nixpkgs-unstable.legacyPackages.${system}.codebase-memory-mcp;

      inherit (pkgs) github-mcp-server;

      mcp-nixos = inputs.nixpkgs-unstable.legacyPackages.${system}.mcp-nixos;

      context7-mcp = inputs.nixpkgs-unstable.legacyPackages.${system}.context7-mcp;

      astGrep = inputs.nixpkgs-unstable.legacyPackages.${system}.ast-grep;

      wrapperModule = (inputs.nix-wrapper-modules.lib.evalModule (import ./wrapper-module.nix)).config;

      # Hypa CLI wrapper — exposed to PATH so HYPA_PI_MODE=additive works.
      # The binary lives inside the @hypabolic/hypa npm package and needs Node.js.
      hypa = pkgs.writeShellScriptBin "hypa" ''
        exec ${pkgs.nodejs}/bin/node ${phenixPiPackage}/node_modules/@hypabolic/hypa/bin.js "$@"
      '';

      # Build config/phenix-pi as a store-backed npm package with all 10
      # declared pi dependencies installed in node_modules.
      phenixPiPackage = import ./phenix-pi-package.nix {
        inherit pkgs lib;
      };

      # Explicit paths to every third-party pi package.
      # Pi sees each one individually so it can discover extensions,
      # skills, prompts, and themes.
      phenixPiPackageDirs = [
        "${phenixPiPackage}/node_modules/pi-subagents"
        "${phenixPiPackage}/node_modules/pi-mcp-adapter"
        "${phenixPiPackage}/node_modules/pi-lens"
        "${phenixPiPackage}/node_modules/@juicesharp/rpiv-ask-user-question"
        "${phenixPiPackage}/node_modules/@juicesharp/rpiv-todo"
        "${phenixPiPackage}/node_modules/@hypabolic/pi-hypa"
        "${phenixPiPackage}/node_modules/@dietrichgebert/ponytail"
        "${phenixPiPackage}/node_modules/@juicesharp/rpiv-web-tools"
        "${phenixPiPackage}/node_modules/pi-context-tools"
      ];

      # Source directory for test fixtures
      srcDir = ../fixtures;

      agentComm = import ./agent_comm_mcp/package.nix { inherit pkgs; };

      wrappedPi = wrapperModule.wrap {
        inherit pkgs;

        package = pkgs.pi-coding-agent;

        pi = {
          configDir = phenixPiPackage;
          packageDirs = phenixPiPackageDirs;

          stateDir = null;

          theme = "catppuccin-mocha";
          managedConfig = true;

          loadConfigDirAsPackage = true;
          directResourceCompat = false;

          skipVersionCheck = true;
          telemetry = false;

          extraPackages = [
            # LSP servers — read-only code intelligence
            pkgs.nil # Nix
            pkgs.typescript-language-server # TypeScript, JavaScript
            pkgs.rust-analyzer # Rust
            pkgs.lua-language-server # Lua
            pkgs.taplo # TOML (taplo lsp)
            pkgs.pyright # Python
            pkgs.vscode-langservers-extracted # JSON, HTML, CSS, Markdown, ESLint
            pkgs.yaml-language-server # YAML, Kubernetes manifests

            # Runtime
            pkgs.nodejs
            pkgs.jq
            pkgs.ripgrep
            pkgs.fd
            astGrep
            agentComm
            inputs.phenix-tend.packages.${system}."tend"
            inputs.phenix-tend.packages.${system}."tend-mcp"
            inputs.phenix-stitch.packages.${system}."stitch"
            inputs.phenix-stitch.packages.${system}."stitch-mcp"
            codebase-memory-mcp
            github-mcp-server
            mcp-nixos
            context7-mcp
            hypa
          ];

          extraEnv = {
            PI_SUBAGENT_EXTRA_AGENT_DIRS = "${phenixPiPackage}/pi/agents";
            # pi-hypa additive mode by default
            HYPA_PI_MODE = "additive";
            HYPA_PI_ENABLE_MCP_PROXY = "0";
          };
        };
      };
    in
    {
      packages = {
        default = wrappedPi;

        pi = wrappedPi;
        phenix-pi-package = phenixPiPackage;

        # Smoke script to list installed pi packages
        # Run with: nix build .#phenix-pi-package-list
        phenix-pi-package-list =
          pkgs.runCommand "phenix-pi-package-list"
            {
              nativeBuildInputs = [ pkgs.findutils ];
            }
            ''
              mkdir -p $out
              {
                echo "Phenix Pi package root: ${phenixPiPackage}"
                echo
                echo "Pi packages:"
                find ${phenixPiPackage}/node_modules -maxdepth 2 -name package.json \
                  | sort \
                  | sed "s#${phenixPiPackage}/node_modules/##"
              } > $out/packages.txt
            '';

        agent-comm = agentComm;

        # Run with: nix run .#test-subagent-isolation
        test-subagent-isolation = pkgs.writeShellScriptBin "test-subagent-isolation" ''
          set -e
          echo "=== Subagent Process Isolation Test (mocked) ==="
          echo ""
          export PATH="${pkgs.nodejs}/bin:${pkgs.typescript}/bin:$PATH"
          cd "${srcDir}"
          echo "Running mocked tests (CI-safe)..."
          npx --yes tsx fixtures/test-subagent-process-isolation.ts
          echo ""
          echo "=== All tests complete ==="
        '';

        # Run with: nix run .#test-subagent-isolation-live
        test-subagent-isolation-live = pkgs.writeShellScriptBin "test-subagent-isolation-live" ''
          set -e
          echo "=== Subagent Process Isolation TEST (LIVE) ==="
          echo ""
          export PATH="${pkgs.nodejs}/bin:${pkgs.typescript}/bin:$PATH"
          cd "${srcDir}"
          echo "Running live subagent spawn test..."
          npx --yes tsx fixtures/test-subagent-process-isolation.ts --live
          echo ""
          echo "=== All tests complete ==="
        '';
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

        phenix-pi-package-check =
          pkgs.runCommand "phenix-pi-package-check"
            {
              nativeBuildInputs = [
                pkgs.jq
                pkgs.gnugrep
                pkgs.findutils
              ];
            }
            ''
              echo "=== checking Phenix Pi package root ==="
              test -e ${phenixPiPackage}/package.json
              test -e ${phenixPiPackage}/package-lock.json

              echo "=== checking Phenix resources ==="
              test -d ${phenixPiPackage}/pi/extensions
              test -d ${phenixPiPackage}/pi/agents
              test -d ${phenixPiPackage}/pi/skills
              test -d ${phenixPiPackage}/pi/prompts
              test -d ${phenixPiPackage}/pi/themes

              echo "=== checking installed Pi package dependencies ==="
              for pkg in \
                pi-subagents pi-mcp-adapter pi-lens \
                @juicesharp/rpiv-ask-user-question \
                @juicesharp/rpiv-todo \
                @hypabolic/pi-hypa \
                @dietrichgebert/ponytail \
                @juicesharp/rpiv-web-tools \
                pi-context-tools
              do
                test -e "${phenixPiPackage}/node_modules/$pkg/package.json" \
                  && echo "  $pkg: OK" \
                  || { echo "FAIL: missing $pkg"; exit 1; }
              done

              echo "=== checking Pi manifest ==="
              jq -e '.pi.extensions' ${phenixPiPackage}/package.json > /dev/null
              jq -e '.pi.agents' ${phenixPiPackage}/package.json > /dev/null
              jq -e '.pi.chains' ${phenixPiPackage}/package.json > /dev/null
              jq -e '.pi.subagents' ${phenixPiPackage}/package.json > /dev/null
              jq -e '.pi.themes' ${phenixPiPackage}/package.json > /dev/null
              # skills and prompts are intentionally omitted from the package
              # manifest; the wrapper generates mcp.json and phenix-flow only
              # injects workflow instructions when a phenix model is active.
              if jq -e '.pi.skills' ${phenixPiPackage}/package.json >/dev/null 2>&1; then
                echo "FAIL: .pi.skills should not be declared in manifest"; exit 1
              fi
              if jq -e '.pi.prompts' ${phenixPiPackage}/package.json >/dev/null 2>&1; then
                echo "FAIL: .pi.prompts should not be declared in manifest"; exit 1
              fi

              echo "All OK"
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
              echo "=== Checking wrapper basics ==="
              grep -F -q 'PI_PACKAGE_DIR' ${wrappedPi}/bin/pi
              grep -F -q 'phenix-pi-settings.json' ${wrappedPi}/bin/pi
              grep -F -q 'phenix-pi-mcp.json' ${wrappedPi}/bin/pi
              echo "wrapper: OK"
              touch $out
            '';
      };
    };
}
