{ inputs, lib, ... }: {
  perSystem =
    { pkgs, system, ... }:
    let
      inherit (inputs) nix-wrapper-modules;
      codebase-memory-mcp = inputs.nixpkgs-unstable.legacyPackages.${system}.codebase-memory-mcp;

      promptsDir = ../prompts;
      commandsDir = ../commands;
      knowledgeDir = ../knowledge;

      promptPath = name: builtins.toString promptsDir + "/${name}.md";
      promptCheckPath =
        name:
        pkgs.writeText "phenix-opencode-${name}-prompt.md" (builtins.readFile (promptsDir + "/${name}.md"));

      readOnlyAgentPermissions = {
        read = "allow";
        glob = "allow";
        grep = "allow";
        list = "allow";
        edit = "deny";
        bash = {
          "*" = "ask";
          "git status*" = "allow";
          "git diff*" = "allow";
          "git log*" = "allow";
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
      };

      workerPermissions = {
        read = "allow";
        glob = "allow";
        grep = "allow";
        list = "allow";
        edit = "allow";
        bash = {
          "*" = "ask";
          "tend *" = "allow";
          "stitch status*" = "allow";
          "stitch exec*" = "allow";
          "stitch plan*" = "allow";
          "stitch dag*" = "allow";
          "cargo check*" = "allow";
          "cargo test*" = "allow";
          "nix flake check*" = "allow";
          "nix build*" = "allow";
          "treefmt*" = "allow";
          "statix*" = "allow";
          "deadnix*" = "allow";
          "git status*" = "allow";
          "git diff*" = "allow";
          "git log*" = "allow";
          "git add*" = "ask";
          "git commit*" = "ask";
          "git push*" = "ask";
          "stitch commit*" = "ask";
          "stitch sync*" = "ask";
        };
        "tend-mcp_*" = "allow";
        "stitch-mcp_*" = "allow";
        "codebase_memory_*" = "ask";
      };

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
              edit = "deny";
              bash = {
                "*" = "ask";
                "git status*" = "allow";
                "git diff*" = "allow";
                "git log*" = "allow";
                "rg *" = "allow";
                "find *" = "allow";
                "mkdir -p .opencodestate*" = "allow";
                "tee .opencodestate/*" = "allow";
                "rm -f .opencodestate/*" = "allow";
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
            };
          };
          workflow = {
            mode = "primary";
            hidden = true;
            description = "Compatibility alias for phenix-workflow.";
            prompt = "{file:${promptPath "workflow"}}";
            permission = {
              edit = "deny";
              task = {
                "*" = "deny";
                "phenix-planner" = "allow";
                "phenix-architect" = "allow";
                "phenix-worker" = "allow";
                "phenix-verifier" = "allow";
                "phenix-architecture-verifier" = "allow";
                "phenix-commit-sync" = "allow";
              };
            };
          };
          "phenix-planner" = {
            mode = "subagent";
            hidden = true;
            description = "Creates and refines task DAGs, acceptance criteria, verification profiles, and handoff memory without editing files.";
            prompt = "{file:${promptPath "planner"}}";
            permission = readOnlyAgentPermissions;
          };
          planner = {
            mode = "subagent";
            hidden = true;
            description = "Compatibility alias for phenix-planner.";
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
          architect = {
            mode = "subagent";
            hidden = true;
            description = "Compatibility alias for phenix-architect.";
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
          implementer = {
            mode = "subagent";
            hidden = true;
            description = "Compatibility alias for phenix-worker.";
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
          verifier = {
            mode = "subagent";
            hidden = true;
            description = "Compatibility alias for phenix-verifier.";
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
          "review-committer" = {
            mode = "subagent";
            hidden = true;
            description = "Compatibility alias for phenix-commit-sync.";
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

      wrappedOpencode = nix-wrapper-modules.wrappers.opencode.wrap {
        inherit pkgs;

        inherit settings;

        envDefault.OPENCODE_DISABLE_AUTOUPDATE = "1";
      };
    in
    {
      packages.default = wrappedOpencode;
      packages.generated-config = generatedConfig;

      checks.generated-config =
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

            jq -e '.agent."phenix-workflow".mode == "primary"' ${generatedConfig}
            jq -e '.agent."phenix-workflow".permission.edit == "deny"' ${generatedConfig}
            jq -e '.agent."phenix-workflow".permission."tend-mcp_*" == "allow"' ${generatedConfig}
            jq -e '.agent."phenix-workflow".permission."stitch-mcp_*" == "allow"' ${generatedConfig}
            jq -e '.agent."phenix-workflow".permission.bash."tend *" == "allow"' ${generatedConfig}
            jq -e '.agent."phenix-workflow".permission.bash."stitch exec*" == "allow"' ${generatedConfig}

            jq -e '.agent."phenix-planner".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."phenix-architect".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."phenix-worker".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."phenix-verifier".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."phenix-architecture-verifier".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."phenix-commit-sync".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."failure-analyzer".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."uiux-designer".mode == "subagent"' ${generatedConfig}

            jq -e '.agent."phenix-worker".permission.edit == "allow"' ${generatedConfig}
            jq -e '.agent."phenix-worker".permission.bash."cargo check*" == "allow"' ${generatedConfig}
            jq -e '.agent."phenix-worker".permission.bash."git commit*" == "ask"' ${generatedConfig}
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
            check_prompt ${promptCheckPath "planner"} 'task_dag:'
            check_prompt ${promptCheckPath "planner"} 'required_verification_profile'
            check_prompt ${promptCheckPath "planner"} 'mcp_preferred_cli_allowed'
            check_prompt ${promptCheckPath "architecture-verifier"} 'manual_repo_loop_found'
            check_prompt ${promptCheckPath "commit-sync"} 'stitch-mcp_stitch_commit'
            check_prompt ${promptCheckPath "commit-sync"} 'Never manually walk repositories'
            check_prompt ${promptCheckPath "verifier"} 'tend_stitch_evidence'

            touch $out
          '';
    };
}
