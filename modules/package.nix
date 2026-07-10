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

      astGrep = inputs.nixpkgs-unstable.legacyPackages.${system}.ast-grep;

      wrapperModule = (inputs.nix-wrapper-modules.lib.evalModule (import ./wrapper-module.nix)).config;

      # Source directory for test fixtures
      srcDir = ../fixtures;

      agentComm = import ./agent_comm_mcp/package.nix { inherit pkgs; };

      phenixPiConfigDir = pkgs.runCommand "phenix-pi-config-dir" { } ''
        cp -r ${../config/phenix-pi} $out
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
            # LSP servers — read-only code intelligence
            pkgs.nil                         # Nix
            pkgs.typescript-language-server   # TypeScript, JavaScript
            pkgs.rust-analyzer                # Rust
            pkgs.lua-language-server          # Lua
            pkgs.taplo                        # TOML (taplo lsp)
            pkgs.pyright                      # Python
            pkgs.vscode-langservers-extracted # JSON, HTML, CSS, Markdown, ESLint
            pkgs.yaml-language-server         # YAML, Kubernetes manifests

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
          ];

          extraEnv = {
            PI_SUBAGENT_EXTRA_AGENT_DIRS = "${phenixPiConfigDir}/pi/agents";
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
        phenix-pi-config-dir = phenixPiConfigDir;
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

        phenix-pi-config-dir-check =
          pkgs.runCommand "phenix-pi-config-dir-check"
            {
              nativeBuildInputs = [
                pkgs.jq
                pkgs.gnugrep
              ];
            }
            ''
              echo "=== package.json structure ==="
              jq -e '.pi.extensions == ["./pi/extensions"]' ${phenixPiConfigDir}/package.json > /dev/null
              jq -e '.dependencies."pi-subagents" == "0.34.0"' ${phenixPiConfigDir}/package.json > /dev/null
              jq -e '.dependencies."pi-lens" == "0.3.0"' ${phenixPiConfigDir}/package.json > /dev/null
              echo "=== agents ==="
              for agent in phenix-scout phenix-planner phenix-worker phenix-worker-recursive phenix-verifier phenix-reviewer phenix-debugger; do
                if [ -f "${phenixPiConfigDir}/pi/agents/$agent.md" ]; then
                  echo "  $agent: OK"
                else
                  echo "FAIL: missing $agent.md"; exit 1
                fi
              done
              echo "=== chains ==="
              for chain in phenix-d0 phenix-d1 phenix-d1-noscout phenix-d2 phenix-d2-noscout phenix-d3 phenix-repair-loop; do
                if [ -f "${phenixPiConfigDir}/pi/chains/$chain.chain.md" ] || [ -f "${phenixPiConfigDir}/pi/chains/$chain.chain.json" ]; then
                  echo "  $chain: OK"
                else
                  echo "FAIL: missing $chain"; exit 1
                fi
              done
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
              echo "wrapper: OK"
              touch $out
            '';
      };
    };
}
