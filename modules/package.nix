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
              test -e ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              test -e ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              test -e ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              test -d ${phenixPiConfigDir}/pi/prompts
              test -d ${phenixPiConfigDir}/pi/skills
              test -d ${phenixPiConfigDir}/pi/agents
              test -d ${phenixPiConfigDir}/pi/extensions/phenix-tools
              test -e ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              test -e ${phenixPiConfigDir}/pi/themes/catppuccin-mocha.json

              # Verify all agent markdown files exist
              for agent in repo_scout planner worker verifier reviewer debugger; do
                test -f "${phenixPiConfigDir}/pi/agents/$agent.md"
              done

              jq -e '.name == "catppuccin-mocha"' ${phenixPiConfigDir}/pi/themes/catppuccin-mocha.json
              jq -e '.colors.accent == "mauve"' ${phenixPiConfigDir}/pi/themes/catppuccin-mocha.json
              jq -e '.colors.bashMode == "peach"' ${phenixPiConfigDir}/pi/themes/catppuccin-mocha.json

              jq -e '.pi.extensions == ["./pi/extensions"]' ${phenixPiConfigDir}/package.json
              jq -e '.pi.agents == ["./pi/agents"]' ${phenixPiConfigDir}/package.json
              jq -e '.pi.skills == ["./pi/skills"]' ${phenixPiConfigDir}/package.json
              jq -e '.pi.prompts == ["./pi/prompts"]' ${phenixPiConfigDir}/package.json
              jq -e '.pi.themes == ["./pi/themes"]' ${phenixPiConfigDir}/package.json

              jq -e '.peerDependencies."@earendil-works/pi-coding-agent" == "*"' ${phenixPiConfigDir}/package.json
              jq -e '.peerDependencies."@earendil-works/pi-ai" == "*"' ${phenixPiConfigDir}/package.json
              jq -e '.peerDependencies."@earendil-works/pi-agent-core" == "*"' ${phenixPiConfigDir}/package.json
              jq -e '.peerDependencies."@earendil-works/pi-tui" == "*"' ${phenixPiConfigDir}/package.json

              # Verify pi-context-tools dependency
              jq -e '.dependencies."pi-context-tools" == "0.1.1"' ${phenixPiConfigDir}/package.json

              grep -F -q 'name: "lsp_diagnostics"' ${phenixPiConfigDir}/pi/extensions/lsp.ts
              grep -F -q 'name: "lsp_hover"' ${phenixPiConfigDir}/pi/extensions/lsp.ts
              grep -F -q 'read-only' ${phenixPiConfigDir}/pi/extensions/lsp.ts
              ! grep -E -q 'codeAction|rename|workspace/applyEdit' ${phenixPiConfigDir}/pi/extensions/lsp.ts

              grep -F -q 'pi.registerProvider(PHENIX_PROVIDER' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              grep -F -q 'pi.registerCommand("router"' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              grep -F -q 'phenix-router.routes.json' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              ! grep -F -q 'setModel(' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts

              # Verify subagent executor has NO direct model API calls
              ! grep -F -q 'streamSimple' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              ! grep -F -q '@earendil-works/pi-ai/compat' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              ! grep -F -q 'createAssistantMessageEventStream' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts

              # Verify subagent executor uses child process spawning
              grep -F -q 'spawn' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q -e '--mode' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q -e '--no-session' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q -e '--model' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q -e '--tools' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q 'PI_SUBAGENT_DEPTH' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q 'runPhenixSubagent' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q 'parsePiJsonOutput' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q 'resolveRoleModel' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts
              grep -F -q 'ROLE_TOOL_DEFAULTS' ${phenixPiConfigDir}/pi/extensions/phenix-subagent-executor.ts

              # Verify phenix-flow extension for multi-agent workflow
              grep -F -q 'pi.registerCommand("flow"' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              grep -F -q 'before_agent_start' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              grep -F -q 'agent_end' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              grep -F -q 'classifying' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              grep -F -q 'executing' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              grep -F -q 'verifying' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              grep -F -q 'sendUserMessage' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              grep -F -q 'ranRealSubagentScout' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts
              ! grep -F -q 'setModel(' ${phenixPiConfigDir}/pi/extensions/phenix-flow.ts

              # Verify phenix-runtime module with all data models
              grep -F -q 'PlanContract' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              grep -F -q 'TaskNode' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              grep -F -q 'PublicCard' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              grep -F -q 'RolePolicy' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              grep -F -q 'assembleSystemPrompt' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              grep -F -q 'resolveScopeIssue' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              grep -F -q 'shouldDelegate' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              grep -F -q 'scopeContainsPath' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              grep -F -q 'DEFAULT_PERMISSIONS' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts
              ! grep -F -q 'setModel(' ${phenixPiConfigDir}/pi/extensions/phenix-runtime.ts

              # Verify router exposes all 5 frontend modes
              grep -F -q '"opencode-go"' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              grep -F -q '"gpt"' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              grep -F -q '"mixed"' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              grep -F -q 'FRONTEND_MODELS' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts

              # Verify router has no retry/mode artifacts
              ! grep -F -q 'flowActive' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              ! grep -F -q 'maxFollowUpRetries' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              ! grep -F -q 'FailureEvidence' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts
              ! grep -F -q 'MODE_DESCRIPTIONS' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts

              # Verify routing matrix module exists in pi/lib/
              test -e ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              ! test -e ${phenixPiConfigDir}/pi/extensions/phenix-routing-matrix.ts
              grep -F -q 'resolveRouting' ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              grep -F -q 'classifyAndRoute' ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              grep -F -q 'classifyDifficulty' ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              grep -F -q 'classifySecrecy' ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              grep -F -q 'classifyChangeKind' ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              grep -F -q 'VALIDATION_PROFILES' ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              grep -F -q 'IMPLEMENTER_RULES' ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              grep -F -q 'VERIFIER_RULES' ${phenixPiConfigDir}/pi/lib/phenix-routing-matrix.ts
              grep -F -q '../lib/phenix-routing-matrix' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts

              # Verify phenix-tools extension with all 11 tools
              grep -F -q 'registerRead' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerSearch' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerFind' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerEdit' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerAstGrep' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerAstEdit' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerLsp' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerTodo' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerTask' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerJob' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts
              grep -F -q 'registerResolve' ${phenixPiConfigDir}/pi/extensions/phenix-tools/index.ts

              # Verify individual tool files exist
              for tool in _shared.ts read.ts search.ts find.ts edit.ts ast_grep.ts ast_edit.ts lsp.ts todo.ts task.ts job.ts resolve.ts; do
                test -f "${phenixPiConfigDir}/pi/extensions/phenix-tools/$tool"
              done

              # Verify no SOPS/auth handling in tools
              ! grep -r -q 'sops\|secretFileEnv\|auth.json\|credential' ${phenixPiConfigDir}/pi/extensions/phenix-tools/

              # Verify router status bar indicator is removed
              ! grep -F -q 'setStatus("phenix-router"' ${phenixPiConfigDir}/pi/extensions/phenix-router.ts

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
              echo "=== Checking PI_PACKAGE_DIR ==="
              grep -F -q 'PI_PACKAGE_DIR' ${wrappedPi}/bin/pi
              grep -F -q '/lib/node_modules/pi-monorepo' ${wrappedPi}/bin/pi
              ! grep -F -q '.cache/phenix-pi/packages' ${wrappedPi}/bin/pi
              ! grep -F -q 'export PI_PACKAGE_DIR="''${PI_PACKAGE_DIR:-"$HOME/.cache/phenix-pi/packages"}"' ${wrappedPi}/bin/pi 2>/dev/null || true

              echo "=== Checking XDG_STATE_HOME ==="
              grep -F -q 'XDG_STATE_HOME' ${wrappedPi}/bin/pi
              grep -F -q '.local/state}/phenix-pi' ${wrappedPi}/bin/pi

              echo "=== Checking managed config ==="
              grep -F -q 'PHENIX_PI_MANAGED_CONFIG' ${wrappedPi}/bin/pi
              grep -F -q 'phenix-pi-settings.json' ${wrappedPi}/bin/pi

              echo "=== Checking no SOPS/secrets ==="
              ! grep -F -q 'PI_SOPS' ${wrappedPi}/bin/pi
              ! grep -F -q 'PI_SECRET' ${wrappedPi}/bin/pi

              SETTINGS_PATH=$(grep -o '/nix/store/[a-z0-9]*-phenix-pi-settings\.json' ${wrappedPi}/bin/pi | head -1)
              if [ -n "$SETTINGS_PATH" ] && [ -f "$SETTINGS_PATH" ]; then
                jq -e '.packages | type == "array" and length == 1' "$SETTINGS_PATH"
                jq -e '.packages[0] | test("phenix-pi-config-dir")' "$SETTINGS_PATH"
                jq -e '.theme == "catppuccin-mocha"' "$SETTINGS_PATH"
                jq -e '.enableInstallTelemetry == false' "$SETTINGS_PATH"
                jq -e '.enableAnalytics == false' "$SETTINGS_PATH"
                jq -e '.defaultProvider == "phenix"' "$SETTINGS_PATH"
                jq -e '.defaultModel == "free"' "$SETTINGS_PATH"
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
