{ inputs, lib, ... }: {
  perSystem =
    { pkgs, system, ... }:
    let
      inherit (inputs) nix-wrapper-modules;
      codebase-memory-mcp = inputs.nixpkgs-unstable.legacyPackages.${system}.codebase-memory-mcp;

      mkMcpServer = name: pkgAttr: {
        type = "local";
        command = [ "${inputs.phenix-tools.packages.${system}."${pkgAttr}"}/bin/${name}" ];
        enabled = true;
      };

      promptsDir = ../prompts;
      commandsDir = ../commands;
      knowledgeDir = ../knowledge;

      promptPath = name: builtins.toString promptsDir + "/${name}.md";

      readOnlyAgentPermissions = {
        read = "allow";
        glob = "allow";
        grep = "allow";
        list = "allow";
        edit = "deny";
        bash = {
          "*" = "deny";
          "git status*" = "allow";
          "git diff*" = "allow";
          "git log*" = "allow";
        };
        "codebase_memory_*" = "allow";
      };

      settings = {
        "$schema" = "https://opencode.ai/config.json";
        autoupdate = false;
        default_agent = "workflow";
        instructions = [ (builtins.toString knowledgeDir + "/glossary.md") ];

        command = {
          flow = {
            description = "Run full Phenix plan -> architecture -> implementation -> verification workflow";
            agent = "workflow";
            template = builtins.readFile (commandsDir + "/flow.md");
          };
        };

        mcp = {
          tend-mcp = mkMcpServer "tend-mcp" "tend-mcp";
          stitch-mcp = mkMcpServer "stitch-mcp" "stitch-mcp";
          codebase_memory = {
            type = "local";
            command = [ "${codebase-memory-mcp}/bin/codebase-memory-mcp" ];
            enabled = true;
            timeout = 10000;
          };
        };

        agent = {
          workflow = {
            mode = "primary";
            temperature = 0.1;
            description = "Default Phenix workflow orchestrator. Routes development work through planner, architect, implementer, verifier, and failure analyzer.";
            prompt = "{file:${promptPath "workflow"}}";
            permission = {
              read = "allow";
              glob = "allow";
              grep = "allow";
              list = "allow";
              edit = "deny";
              bash = {
                "*" = "deny";
                "git status*" = "allow";
                "git diff*" = "allow";
                "git log*" = "allow";
                "rg *" = "allow";
                "grep *" = "allow";
                "find *" = "allow";
                "ls *" = "allow";
                "pwd" = "allow";
                "cat *" = "allow";
                "mkdir -p .opencodestate*" = "allow";
                "tee .opencodestate/*" = "allow";
                "rm -f .opencodestate/*" = "allow";
                "stitch *" = "allow";
              };
              task = {
                "*" = "deny";
                planner = "allow";
                architect = "allow";
                implementer = "allow";
                verifier = "allow";
                "review-committer" = "allow";
                "failure-analyzer" = "allow";
                "uiux-designer" = "allow";
              };
              "codebase_memory_*" = "allow";
              "stitch-mcp_*" = "allow";
            };
          };
          planner = {
            mode = "subagent";
            hidden = true;
            description = "Creates structured implementation plans without editing files.";
            prompt = "{file:${promptPath "planner"}}";
            permission = readOnlyAgentPermissions;
          };
          architect = {
            mode = "subagent";
            hidden = true;
            description = "Checks implementation plans against Phenix architecture, dependency direction, and repository contracts.";
            prompt = "{file:${promptPath "architect"}}";
            permission = readOnlyAgentPermissions;
          };
          implementer = {
            mode = "subagent";
            hidden = true;
            description = "Applies architect-approved planned changes to files. Use only after workflow has accepted planner and architect artifacts.";
            prompt = "{file:${promptPath "implementer"}}";
            permission = {
              read = "allow";
              glob = "allow";
              grep = "allow";
              list = "allow";
              edit = "allow";
              bash = "ask";
              "codebase_memory_*" = "ask";
            };
          };
          verifier = {
            mode = "subagent";
            hidden = true;
            description = "Verifies mechanical checks, plan conformance, and architecture conformance after implementation.";
            prompt = "{file:${promptPath "verifier"}}";
            permission = readOnlyAgentPermissions;
          };
          "review-committer" = {
            mode = "subagent";
            hidden = true;
            description = "Final post-verification review and Stitch-safe commit gate for explicit commit policies.";
            prompt = "{file:${promptPath "review-committer"}}";
            permission = readOnlyAgentPermissions // {
              bash = readOnlyAgentPermissions.bash // {
                "stitch *" = "allow";
              };
              "stitch-mcp_*" = "allow";
            };
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
            nativeBuildInputs = [ pkgs.jq ];
          }
          ''
            jq -e '.default_agent == "workflow"' ${generatedConfig}
            jq -e '.command.flow.agent == "workflow"' ${generatedConfig}
            jq -e 'has("commands") | not' ${generatedConfig}
            jq -e 'has("prompts") | not' ${generatedConfig}
            jq -e '.instructions | type == "array" and length >= 1' ${generatedConfig}
            jq -e '.instructions[0] | type == "string" and test("glossary\\.md$")' ${generatedConfig}

            jq -e '.agent.workflow.mode == "primary"' ${generatedConfig}
            jq -e '.agent.workflow.permission.edit == "deny"' ${generatedConfig}
            jq -e '.agent.workflow.permission."stitch-mcp_*" == "allow"' ${generatedConfig}
            jq -e '.agent.workflow.permission.bash."stitch *" == "allow"' ${generatedConfig}

            jq -e '.agent.planner.mode == "subagent"' ${generatedConfig}
            jq -e '.agent.architect.mode == "subagent"' ${generatedConfig}
            jq -e '.agent.implementer.mode == "subagent"' ${generatedConfig}
            jq -e '.agent.verifier.mode == "subagent"' ${generatedConfig}
            jq -e '.agent."review-committer".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."failure-analyzer".mode == "subagent"' ${generatedConfig}
            jq -e '.agent."uiux-designer".mode == "subagent"' ${generatedConfig}

            jq -e '.agent.implementer.permission.edit == "allow"' ${generatedConfig}
            jq -e '.agent.planner.permission.edit == "deny"' ${generatedConfig}
            jq -e '.agent.architect.permission.edit == "deny"' ${generatedConfig}
            jq -e '.agent.verifier.permission.edit == "deny"' ${generatedConfig}
            jq -e '.agent."review-committer".permission.edit == "deny"' ${generatedConfig}
            jq -e '.agent."review-committer".permission."stitch-mcp_*" == "allow"' ${generatedConfig}
            jq -e '.agent."failure-analyzer".permission.edit == "deny"' ${generatedConfig}
            jq -e '.agent."uiux-designer".permission.edit == "deny"' ${generatedConfig}

            jq -e '.agent.workflow.permission.task.planner == "allow"' ${generatedConfig}
            jq -e '.agent.workflow.permission.task.architect == "allow"' ${generatedConfig}
            jq -e '.agent.workflow.permission.task.implementer == "allow"' ${generatedConfig}
            jq -e '.agent.workflow.permission.task.verifier == "allow"' ${generatedConfig}
            jq -e '.agent.workflow.permission.task."review-committer" == "allow"' ${generatedConfig}
            jq -e '.agent.workflow.permission.task."failure-analyzer" == "allow"' ${generatedConfig}
            jq -e '.agent.workflow.permission.task."uiux-designer" == "allow"' ${generatedConfig}

            jq -e '.agent.workflow.description | type == "string" and length > 0' ${generatedConfig}
            jq -e '.agent.planner.description | type == "string" and length > 0' ${generatedConfig}
            jq -e '.agent.architect.description | type == "string" and length > 0' ${generatedConfig}
            jq -e '.agent.implementer.description | type == "string" and length > 0' ${generatedConfig}
            jq -e '.agent.verifier.description | type == "string" and length > 0' ${generatedConfig}
            jq -e '.agent."review-committer".description | type == "string" and length > 0' ${generatedConfig}
            jq -e '.agent."failure-analyzer".description | type == "string" and length > 0' ${generatedConfig}
            jq -e '.agent."uiux-designer".description | type == "string" and length > 0' ${generatedConfig}

            jq -e '[.agent[] | .description] | all(type == "string" and length > 0)' ${generatedConfig}
            jq -e '[.agent[] | .mode] | all(. == "primary" or . == "subagent")' ${generatedConfig}
            jq -e '[.agent[] | select(.mode == "subagent") | .hidden] | all(. == true)' ${generatedConfig}

            touch $out
          '';
    };
}
