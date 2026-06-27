{ inputs, lib, ... }: {
  perSystem = { pkgs, system, ... }: let
    nix-wrapper-modules = inputs.nix-wrapper-modules;
    codebase-memory-mcp = inputs.nixpkgs-unstable.legacyPackages.${system}.codebase-memory-mcp;

    mkMcpServer = name: pkgAttr: {
      type = "local";
      command = [ "${inputs.phenix-tools.packages.${system}."${pkgAttr}"}/bin/${name}" ];
      enabled = true;
    };

    promptsDir = ../prompts;
    commandsDir = ../commands;

    promptPath = name: builtins.toString promptsDir + "/${name}.md";

    agentPermissions = {
      "codebase_memory_*" = "allow";
    };

    wrappedOpencode = nix-wrapper-modules.wrappers.opencode.wrap {
      inherit pkgs;

      settings = {
        "$schema" = "https://opencode.ai/config.json";
        autoupdate = false;

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
              };
              task = {
                "*" = "deny";
                planner = "allow";
                architect = "allow";
                implementer = "allow";
                verifier = "allow";
                "failure-analyzer" = "allow";
              };
              "codebase_memory_*" = "allow";
            };
          };
          planner = {
            prompt = "{file:${promptPath "planner"}}";
            permission = agentPermissions;
          };
          architect = {
            prompt = "{file:${promptPath "architect"}}";
            permission = agentPermissions;
          };
          implementer = {
            prompt = "{file:${promptPath "implementer"}}";
            permission = {
              "codebase_memory_*" = "ask";
            };
          };
          verifier = {
            prompt = "{file:${promptPath "verifier"}}";
            permission = agentPermissions;
          };
          "failure-analyzer" = {
            prompt = "{file:${promptPath "failure-analyzer"}}";
            permission = agentPermissions;
          };
        };
      };

      envDefault.OPENCODE_DISABLE_AUTOUPDATE = "1";
    };
  in {
    packages.default = wrappedOpencode;
  };
}
