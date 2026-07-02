{ inputs, lib, ... }: {
  perSystem =
    { pkgs, system, ... }:
    let
      inherit (inputs) nix-wrapper-modules;
      codebase-memory-mcp = inputs.nixpkgs-unstable.legacyPackages.${system}.codebase-memory-mcp;
      inherit (pkgs) github-mcp-server;

      promptsDir = ../prompts;
      commandsDir = ../commands;
      knowledgeDir = ../knowledge;
      piDir = ../pi;
      piPromptsDir = piDir + "/prompts";
      piSkillsDir = piDir + "/skills";
      piExtensionsDir = piDir + "/extensions";

      promptPath = name: builtins.toString promptsDir + "/${name}.md";
      promptCheckPath =
        name:
        pkgs.writeText "phenix-opencode-${name}-prompt.md" (builtins.readFile (promptsDir + "/${name}.md"));

      safeInspectionBashPermissions = {
        "git status*" = "allow";
        "git diff*" = "allow";
        "git log*" = "allow";
        "git show*" = "allow";
        "nix flake check*" = "allow";
        "nix flake show*" = "allow";
        "nix flake metadata*" = "allow";
        "nix eval*" = "allow";
        "nix build*" = "allow";
        "nix develop*" = "allow";
        "nix shell*" = "allow";
        "nix run*" = "allow";
        "nix repl*" = "allow";
        "nix path-info*" = "allow";
        "nix store ls*" = "allow";
        "nix store cat*" = "allow";
        "nix store diff-closures*" = "allow";
        "nix why-depends*" = "allow";
        "nix derivation show*" = "allow";
        "nix-build*" = "allow";
        "nix-shell*" = "allow";
        "nix-instantiate*" = "allow";
      };

      reversibleSingleRepoGitPermissions = {
        "git branch --show-current*" = "allow";
        "git branch --list*" = "allow";
        "git branch -m*" = "allow";
        "git switch -c*" = "allow";
        "git add*" = "allow";
        "git reset HEAD*" = "allow";
        "git reset --soft*" = "allow";
        "git stash*" = "allow";
        "git fetch*" = "allow";
        "git pull --ff-only*" = "allow";
      };

      destructiveGitSafeguards = {
        "git commit*" = "ask";
        "git push*" = "ask";
        "git tag*" = "ask";
        "git merge*" = "ask";
        "git rebase*" = "ask";
        "git cherry-pick*" = "ask";
        "git revert*" = "ask";
        "git reset --hard*" = "ask";
        "git clean*" = "deny";
        "git branch -D*" = "ask";
        "git push --force*" = "ask";
        "git push --delete*" = "ask";
      };

      destructiveNixSafeguards = {
        "nix flake update*" = "ask";
        "nix flake lock*" = "ask";
        "nix profile*" = "ask";
        "nix registry add*" = "ask";
        "nix registry remove*" = "ask";
        "nix channel*" = "ask";
        "nix-env*" = "ask";
        "nix store delete*" = "ask";
        "nix store optimise*" = "ask";
        "nix-collect-garbage*" = "ask";
        "nix copy*" = "ask";
        "nix store sign*" = "ask";
        "nix key*" = "ask";
      };

      agentCommPermissions = {
        "agent_comm_*" = "allow";
      };

      readOnlyAgentPermissions = {
        read = "allow";
        glob = "allow";
        grep = "allow";
        list = "allow";
        lsp = "allow";
        edit = "deny";
        bash =
          safeInspectionBashPermissions
          // destructiveNixSafeguards
          // {
            "*" = "ask";
            "rg *" = "allow";
            "find *" = "allow";
            "tend *" = "allow";
            "stitch status*" = "allow";
            "stitch exec*" = "allow";
            "stitch plan*" = "allow";
            "stitch dag*" = "allow";
          };
        "tend-mcp_*" = "allow";
        "stitch-mcp_*" = "allow";
        "codebase_memory_*" = "allow";
      }
      // agentCommPermissions;

      workerPermissions = {
        read = "allow";
        glob = "allow";
        grep = "allow";
        list = "allow";
        lsp = "allow";
        edit = "allow";
        bash =
          safeInspectionBashPermissions
          // reversibleSingleRepoGitPermissions
          // destructiveGitSafeguards
          // destructiveNixSafeguards
          // {
            "*" = "ask";
            "tend *" = "allow";
            "stitch status*" = "allow";
            "stitch exec*" = "allow";
            "stitch plan*" = "allow";
            "stitch dag*" = "allow";
            "cargo check*" = "allow";
            "cargo test*" = "allow";
            "treefmt*" = "allow";
            "statix*" = "allow";
            "deadnix*" = "allow";
            "stitch commit*" = "ask";
            "stitch sync*" = "ask";
          };
        "tend-mcp_*" = "allow";
        "stitch-mcp_*" = "allow";
        "codebase_memory_*" = "ask";
      }
      // agentCommPermissions;

      commitSyncPermissions = readOnlyAgentPermissions // {
        bash = readOnlyAgentPermissions.bash // {
          "stitch commit*" = "ask";
          "stitch sync*" = "ask";
          "git commit*" = "ask";
          "git push*" = "ask";
        };
      };

      settings = {
        "$schema" = "https://opencode.ai/config.json";
        autoupdate = false;
        default_agent = "phenix-workflow";
        instructions = [ (builtins.toString knowledgeDir + "/glossary.md") ];

        lsp = {
          typescript = {
            command = [
              "typescript-language-server"
              "--stdio"
            ];
            extensions = [
              ".ts"
              ".tsx"
              ".js"
              ".jsx"
            ];
          };
          nix = {
            command = [ "nil" ];
            extensions = [ ".nix" ];
          };
        };

        command = {
          flow = {
            description = "Run full Phenix plan -> architecture -> implementation -> verification workflow";
            agent = "phenix-workflow";
            template = builtins.readFile (commandsDir + "/flow.md");
          };
        };

        mcp = {
          tend-mcp = {
            type = "local";
            command = [ "${inputs.phenix-tend.packages.${system}."tend-mcp"}/bin/tend-mcp" ];
            enabled = true;
          };
          stitch-mcp = {
            type = "local";
            command = [ "${inputs.phenix-stitch.packages.${system}."stitch-mcp"}/bin/stitch-mcp" ];
            enabled = true;
          };
          codebase_memory = {
            type = "local";
            command = [ "${codebase-memory-mcp}/bin/codebase-memory-mcp" ];
            enabled = true;
            timeout = 10000;
          };
          agent_comm = {
            type = "local";
            command = [
              "${agentComm}/bin/phenix-agent-comm-mcp"
              "stdio-mcp"
            ];
            enabled = true;
            timeout = 10000;
          };
          github = {
            type = "local";
            command = [
              "${github-mcp-server}/bin/github-mcp-server"
              "stdio"
            ];
            enabled = true;
            environment.GITHUB_PERSONAL_ACCESS_TOKEN = "{env:GITHUB_PERSONAL_ACCESS_TOKEN}";
          };
        };

        agent = {
          "phenix-workflow" = {
            mode = "primary";
            temperature = 0.1;
            description = "Stable Phenix frontend agent. Builds a task DAG, selects the minimum sufficient pipeline, delegates typed nodes, and prefers tend/stitch MCP operations with CLI fallback.";
            prompt = "{file:${promptPath "workflow"}}";
            permission = {
              read = "allow";
              glob = "allow";
              grep = "allow";
              list = "allow";
              lsp = "allow";
              edit = "deny";
              bash =
                safeInspectionBashPermissions
                // destructiveNixSafeguards
                // {
                  "*" = "ask";
                  "rg *" = "allow";
                  "find *" = "allow";
                  "tend *" = "allow";
                  "stitch status*" = "allow";
                  "stitch exec*" = "allow";
                  "stitch plan*" = "allow";
                  "stitch dag*" = "allow";
                };
              task = {
                "*" = "deny";
                "phenix-planner" = "allow";
                "phenix-architect" = "allow";
                "phenix-worker" = "allow";
                "phenix-verifier" = "allow";
                "phenix-architecture-verifier" = "allow";
                "phenix-commit-sync" = "allow";
                "failure-analyzer" = "allow";
                "uiux-designer" = "allow";
              };
              "tend-mcp_*" = "allow";
              "codebase_memory_*" = "allow";
              "stitch-mcp_*" = "allow";
            }
            // agentCommPermissions;
          };
          "phenix-planner" = {
            mode = "subagent";
            hidden = true;
            description = "Creates and refines task DAGs, acceptance criteria, verification profiles, and handoff memory without editing files.";
            prompt = "{file:${promptPath "planner"}}";
            permission = readOnlyAgentPermissions;
          };
          "phenix-architect" = {
            mode = "subagent";
            hidden = true;
            description = "Checks task DAGs, plans, module boundaries, dependency direction, flake topology, and tend/stitch/MCP layering without editing files.";
            prompt = "{file:${promptPath "architect"}}";
            permission = readOnlyAgentPermissions;
          };
          "phenix-worker" = {
            mode = "subagent";
            hidden = true;
            description = "Implements leased task packets, stays inside scope, emits checkpoints, and uses tend/stitch MCP operations before CLI fallback.";
            prompt = "{file:${promptPath "implementer"}}";
            permission = workerPermissions;
          };
          "phenix-verifier" = {
            mode = "subagent";
            hidden = true;
            description = "Verifies the actual diff, required tend/stitch evidence, profile/scope/order, and task-packet conformance without editing files.";
            prompt = "{file:${promptPath "verifier"}}";
            permission = readOnlyAgentPermissions;
          };
          "phenix-architecture-verifier" = {
            mode = "subagent";
            hidden = true;
            description = "Final read-only architecture verifier for accepted constraints, scope control, dependency direction, public API/config semantics, and flake/DAG/tend/stitch/MCP invariants.";
            prompt = "{file:${promptPath "architecture-verifier"}}";
            permission = readOnlyAgentPermissions;
          };
          "phenix-commit-sync" = {
            mode = "subagent";
            hidden = true;
            description = "Guarded executor for explicit commit/sync operations. Uses stitch MCP first and stitch CLI fallback; never manually walks repositories.";
            prompt = "{file:${promptPath "commit-sync"}}";
            permission = commitSyncPermissions;
          };
          "failure-analyzer" = {
            mode = "subagent";
            hidden = true;
            description = "Analyzes failed verification and produces structured feedback for replanning.";
            prompt = "{file:${promptPath "failure-analyzer"}}";
            permission = readOnlyAgentPermissions;
          };
          "uiux-designer" = {
            mode = "subagent";
            hidden = true;
            description = "Advisory UI/UX critic for user-facing Phenix and non-Phenix changes involving launcher, dashboard, shell, CLI/TUI interaction, visual hierarchy, animations, navigation, and discoverability.";
            prompt = "{file:${promptPath "uiux-designer"}}";
            permission = readOnlyAgentPermissions;
          };
        };
      };

      generatedConfig = pkgs.writeText "phenix-opencode.json" (builtins.toJSON settings);

      piSettings = {
        defaultProjectTrust = "ask";
        enableInstallTelemetry = false;
        extensions = [ (builtins.toString piExtensionsDir + "/lsp.ts") ];
        skills = [ (builtins.toString piSkillsDir) ];
        prompts = [ (builtins.toString piPromptsDir) ];
      };

      piPackageManifest = {
        name = "@matthis-k/phenix-pi";
        version = "0.1.0";
        private = false;
        description = "Phenix workflow resources and read-only LSP tools for Pi.";
        keywords = [
          "pi-package"
          "phenix"
          "lsp"
        ];
        pi = {
          extensions = [ "./pi/extensions" ];
          skills = [ "./pi/skills" ];
          prompts = [ "./pi/prompts" ];
        };
        dependencies = {
          "@earendil-works/pi-coding-agent" = "^0.80.2";
          typebox = "^1.0.59";
        };
      };

      generatedPiSettings = pkgs.writeText "phenix-pi-settings.json" (builtins.toJSON piSettings);
      generatedPiPackageJson = pkgs.writeText "phenix-pi-package.json" (
        builtins.toJSON piPackageManifest
      );
      generatedPiConfigDir = pkgs.runCommand "phenix-pi-config" { } ''
        mkdir -p $out
        cp ${generatedPiSettings} $out/settings.json
      '';

      wrappedOpencode = nix-wrapper-modules.wrappers.opencode.wrap {
        inherit pkgs;

        inherit settings;

        envDefault.OPENCODE_DISABLE_AUTOUPDATE = "1";
        envDefault.PATH = lib.makeBinPath [
          pkgs.nil
          pkgs.typescript-language-server
        ];
      };

      opencodeWithGithubToken = pkgs.writeShellApplication {
        name = "opencode";
        runtimeInputs = [ pkgs.coreutils ];
        text = ''
          if [ -z "''${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ] && [ -r /run/secrets/github_token ]; then
            token="$(< /run/secrets/github_token)"
            while [[ "$token" == [[:space:]]* ]]; do
              token="''${token:1}"
            done
            while [[ "$token" == *[[:space:]] ]]; do
              token="''${token:0:''${#token}-1}"
            done
            export GH_TOKEN="$token"
            export GITHUB_TOKEN="$token"
            export GITHUB_PERSONAL_ACCESS_TOKEN="$token"
          fi

          exec ${wrappedOpencode}/bin/opencode "$@"
        '';
      };

      wrappedPi = pkgs.writeShellApplication {
        name = "pi";
        runtimeInputs = [
          pkgs.pi-coding-agent
          pkgs.nil
          pkgs.typescript-language-server
        ];
        text = ''
          if [ -z "''${PI_CODING_AGENT_DIR:-}" ]; then
            PI_CODING_AGENT_DIR="''${XDG_CONFIG_HOME:-$HOME/.config}/phenix-pi"
          fi
          export PI_CODING_AGENT_DIR
          mkdir -p "$PI_CODING_AGENT_DIR"
          if [ ! -e "$PI_CODING_AGENT_DIR/settings.json" ] || [ ${generatedPiConfigDir}/settings.json -nt "$PI_CODING_AGENT_DIR/settings.json" ]; then
            cp ${generatedPiConfigDir}/settings.json "$PI_CODING_AGENT_DIR/settings.json"
          fi
          export PI_PACKAGE_DIR="''${PI_PACKAGE_DIR:-$HOME/.cache/phenix-pi/packages}"
          export PI_SKIP_VERSION_CHECK="''${PI_SKIP_VERSION_CHECK:-1}"
          export PI_TELEMETRY="''${PI_TELEMETRY:-0}"
          exec pi "$@"
        '';
      };

      agentComm = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-agent-comm";
        version = "0.1.0";
        src = ../.;
        cargoLock.lockFile = ../Cargo.lock;
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [ pkgs.sqlite ];
      };
    in
    {
      packages = {
        default = opencodeWithGithubToken;
        opencode = opencodeWithGithubToken;
        pi = wrappedPi;
        agent-comm = agentComm;
        generated-config = generatedConfig;
        generated-pi-settings = generatedPiSettings;
        generated-pi-package-json = generatedPiPackageJson;
      };

      checks = {
        agent-comm = agentComm;

        generated-config =
          pkgs.runCommand "phenix-opencode-generated-config-check"
            {
              nativeBuildInputs = [
                pkgs.jq
                pkgs.gnugrep
              ];
            }
            ''
              jq -e '.default_agent == "phenix-workflow"' ${generatedConfig}
              jq -e '.command.flow.agent == "phenix-workflow"' ${generatedConfig}
              jq -e 'has("commands") | not' ${generatedConfig}
              jq -e 'has("prompts") | not' ${generatedConfig}
              jq -e '.instructions | type == "array" and length >= 1' ${generatedConfig}
              jq -e '.instructions[0] | type == "string" and test("glossary\\.md$")' ${generatedConfig}
              jq -e '.lsp.typescript.command == ["typescript-language-server", "--stdio"]' ${generatedConfig}
              jq -e '.lsp.typescript.extensions == [".ts", ".tsx", ".js", ".jsx"]' ${generatedConfig}
              jq -e '.lsp.nix.command == ["nil"]' ${generatedConfig}
              jq -e '.lsp.nix.extensions == [".nix"]' ${generatedConfig}

              jq -e '.mcp.github.type == "local"' ${generatedConfig}
              jq -e '.mcp.github.enabled == true' ${generatedConfig}
              jq -e '.mcp.github.command | type == "array" and length == 2 and (.[0] | test("/bin/github-mcp-server$")) and .[1] == "stdio"' ${generatedConfig}
              jq -e '.mcp.github.environment.GITHUB_PERSONAL_ACCESS_TOKEN == "{env:GITHUB_PERSONAL_ACCESS_TOKEN}"' ${generatedConfig}
              jq -e '.mcp.agent_comm.type == "local"' ${generatedConfig}
              jq -e '.mcp.agent_comm.command | type == "array" and length == 2 and (.[0] | test("/bin/phenix-agent-comm-mcp$")) and .[1] == "stdio-mcp"' ${generatedConfig}

              jq -e '.agent."phenix-workflow".mode == "primary"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.edit == "deny"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.lsp == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission."tend-mcp_*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission."stitch-mcp_*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission."agent_comm_*" == "allow"' ${generatedConfig}
              denied_permission="comm""_*"
              jq -e --arg denied "$denied_permission" '[paths(scalars) as $p | {key: ($p[-1] | tostring), value: getpath($p)}] | all(.key != $denied and .value != $denied)' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.bash."tend *" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.bash."stitch exec*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.bash | keys | all(contains("agent-state") | not)' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.bash | has("mkdir -p .opencodestate*") | not' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.bash | has("python -c *flake.nix*") | not' ${generatedConfig}

              jq -e '.agent."phenix-planner".mode == "subagent"' ${generatedConfig}
              jq -e '.agent."phenix-architect".mode == "subagent"' ${generatedConfig}
              jq -e '.agent."phenix-worker".mode == "subagent"' ${generatedConfig}
              jq -e '.agent."phenix-verifier".mode == "subagent"' ${generatedConfig}
              jq -e '.agent."phenix-architecture-verifier".mode == "subagent"' ${generatedConfig}
              jq -e '.agent."phenix-commit-sync".mode == "subagent"' ${generatedConfig}
              jq -e '.agent."failure-analyzer".mode == "subagent"' ${generatedConfig}
              jq -e '.agent."uiux-designer".mode == "subagent"' ${generatedConfig}

              jq -e '.agent."phenix-worker".permission.edit == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.lsp == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."cargo check*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git add*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git branch --show-current*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git branch --list*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git branch -m*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git switch -c*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git reset HEAD*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git reset --soft*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash | has("git branch*") | not' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash | has("git switch*") | not' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash | has("git reset*") | not' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git reset --hard*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git clean*" == "deny"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git branch -D*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git commit*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git push*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git push --force*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."git push --delete*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."nix eval*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."nix develop*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."nix store ls*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."nix flake update*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission.bash."nix store delete*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-worker".permission."agent_comm_*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-planner".permission."agent_comm_*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-planner".permission.edit == "deny"' ${generatedConfig}
              jq -e '.agent."phenix-architect".permission.edit == "deny"' ${generatedConfig}
              jq -e '.agent."phenix-verifier".permission.edit == "deny"' ${generatedConfig}
              jq -e '.agent."phenix-architecture-verifier".permission.edit == "deny"' ${generatedConfig}
              jq -e '.agent."phenix-commit-sync".permission.edit == "deny"' ${generatedConfig}
              jq -e '.agent."phenix-commit-sync".permission."stitch-mcp_*" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-commit-sync".permission.bash."stitch commit*" == "ask"' ${generatedConfig}
              jq -e '.agent."phenix-commit-sync".permission.bash."stitch sync*" == "ask"' ${generatedConfig}
              jq -e '.agent."failure-analyzer".permission.edit == "deny"' ${generatedConfig}
              jq -e '.agent."uiux-designer".permission.edit == "deny"' ${generatedConfig}

              jq -e '.agent."phenix-workflow".permission.task."phenix-planner" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.task."phenix-architect" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.task."phenix-worker" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.task."phenix-verifier" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.task."phenix-architecture-verifier" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.task."phenix-commit-sync" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.task."failure-analyzer" == "allow"' ${generatedConfig}
              jq -e '.agent."phenix-workflow".permission.task."uiux-designer" == "allow"' ${generatedConfig}

              jq -e '.agent | has("workflow") | not' ${generatedConfig}
              jq -e '.agent | has("planner") | not' ${generatedConfig}
              jq -e '.agent | has("architect") | not' ${generatedConfig}
              jq -e '.agent | has("implementer") | not' ${generatedConfig}
              jq -e '.agent | has("verifier") | not' ${generatedConfig}
              denied_review="review""-committer"
              jq -e --arg denied "$denied_review" '.agent | has($denied) | not' ${generatedConfig}

              jq -e '.agent."phenix-workflow".description | type == "string" and length > 0' ${generatedConfig}
              jq -e '.agent."phenix-planner".description | type == "string" and length > 0' ${generatedConfig}
              jq -e '.agent."phenix-architect".description | type == "string" and length > 0' ${generatedConfig}
              jq -e '.agent."phenix-worker".description | type == "string" and length > 0' ${generatedConfig}
              jq -e '.agent."phenix-verifier".description | type == "string" and length > 0' ${generatedConfig}
              jq -e '.agent."phenix-architecture-verifier".description | type == "string" and length > 0' ${generatedConfig}
              jq -e '.agent."phenix-commit-sync".description | type == "string" and length > 0' ${generatedConfig}
              jq -e '.agent."failure-analyzer".description | type == "string" and length > 0' ${generatedConfig}
              jq -e '.agent."uiux-designer".description | type == "string" and length > 0' ${generatedConfig}

              jq -e '[.agent[] | .description] | all(type == "string" and length > 0)' ${generatedConfig}
              jq -e '[.agent[] | .mode] | all(. == "primary" or . == "subagent")' ${generatedConfig}
              jq -e '[.agent[] | select(.mode == "subagent") | .hidden] | all(. == true)' ${generatedConfig}

              check_prompt() {
                file="$1"
                pattern="$2"
                grep -F -q -- "$pattern" "$file" || {
                  echo "missing prompt assertion: $pattern in $file" >&2
                  exit 1
                }
              }

              check_prompt ${promptCheckPath "workflow"} 'Execution is task-DAG driven'
              check_prompt ${promptCheckPath "workflow"} 'simple_local'
              check_prompt ${promptCheckPath "workflow"} 'medium_local_verified'
              check_prompt ${promptCheckPath "workflow"} 'dag_full_verified'
              check_prompt ${promptCheckPath "workflow"} 'full_complete_test'
              check_prompt ${promptCheckPath "workflow"} 'Record `transport: mcp` or `transport: cli`'
              check_prompt ${promptCheckPath "workflow"} 'manually looping through repos'
              check_prompt ${promptCheckPath "workflow"} 'Reversible single-repo Git and safe Nix commands may be permitted'
              check_prompt ${promptCheckPath "workflow"} 'Irreversible Git/Nix actions stay'
              check_prompt ${promptCheckPath "planner"} 'task_dag:'
              check_prompt ${promptCheckPath "planner"} 'required_verification_profile'
              check_prompt ${promptCheckPath "planner"} 'mcp_preferred_cli_allowed'
              check_prompt ${promptCheckPath "architecture-verifier"} 'manual_repo_loop_found'
              check_prompt ${promptCheckPath "commit-sync"} 'stitch-mcp_stitch_commit'
              check_prompt ${promptCheckPath "commit-sync"} 'Never manually walk repositories'
              check_prompt ${promptCheckPath "commit-sync"} 'Stitch remains the orchestrator for multi-repo, DAG-aware, sync, and structural commit flows'
              check_prompt ${promptCheckPath "verifier"} 'tend_stitch_evidence'

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
              jq -e 'has("lsp") | not' ${generatedPiSettings}
              jq -e '.extensions[0] | test("pi/extensions/lsp\\.ts$")' ${generatedPiSettings}
              jq -e '.skills[0] | test("pi/skills$")' ${generatedPiSettings}
              jq -e '.prompts[0] | test("pi/prompts$")' ${generatedPiSettings}
              jq -e '.pi.extensions == ["./pi/extensions"]' ${generatedPiPackageJson}
              jq -e '.pi.skills == ["./pi/skills"]' ${generatedPiPackageJson}
              jq -e '.pi.prompts == ["./pi/prompts"]' ${generatedPiPackageJson}
              jq -e '.dependencies."@earendil-works/pi-coding-agent" | type == "string"' ${generatedPiPackageJson}

              grep -F -q 'PI_CODING_AGENT_DIR="''${XDG_CONFIG_HOME:-$HOME/.config}/phenix-pi"' ${wrappedPi}/bin/pi
              grep -F -q '${generatedPiConfigDir}/settings.json' ${wrappedPi}/bin/pi
              ! grep -F -q 'PI_CODING_AGENT_DIR="${generatedPiConfigDir}"' ${wrappedPi}/bin/pi

              grep -F -q 'name: "lsp_diagnostics"' ${piExtensionsDir}/lsp.ts
              grep -F -q 'name: "lsp_hover"' ${piExtensionsDir}/lsp.ts
              grep -F -q 'read-only' ${piExtensionsDir}/lsp.ts
              ! grep -E -q 'codeAction|rename|workspace/applyEdit' ${piExtensionsDir}/lsp.ts

              touch $out
            '';
      };
    };
}
