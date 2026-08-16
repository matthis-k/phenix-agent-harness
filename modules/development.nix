{ inputs, ... }:
{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:
    let
      maintenanceLib = inputs.phenix-flake-ci.lib;

      repositoryRoot = ''
        repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
        cd "$repo_root"
      '';
      rustRoot = ''
        ${repositoryRoot}
        cd rust
      '';

      sourceCi = {
        enable = true;
        stage = "source";
        name = "Source";
        timeoutMinutes = 20;
      };
      rustCi = {
        enable = true;
        stage = "rust";
        name = "Rust";
        timeoutMinutes = 60;
        needs = [ "source" ];
        env = {
          CARGO_HOME = "\${{ runner.temp }}/phenix-cargo-home";
          CARGO_TARGET_DIR = "\${{ runner.temp }}/phenix-cargo-target";
        };
      };
      productCi = {
        enable = true;
        stage = "product";
        name = "Product";
        timeoutMinutes = 60;
        needs = [ "source" ];
      };

      integrationTargets = [
        {
          id = "backend-acp-persistent-continuity";
          package = "phenix-backend-acp";
          test = "persistent_continuity";
          label = "phenix-backend-acp / persistent_continuity";
        }
        {
          id = "phenix-acp-repeated-prompts";
          package = "phenix-acp";
          test = "repeated_prompts";
          label = "phenix-acp / repeated_prompts";
        }
      ];

      systemTargets = [
        {
          id = "conductor-model-tool-loop";
          package = "phenix-conductor";
          test = "black_box_model_tool_loop";
          label = "conductor / black_box_model_tool_loop";
        }
        {
          id = "conductor-execution-providers";
          package = "phenix-conductor";
          test = "execution_provider_runtime";
          label = "conductor / execution_provider_runtime";
        }
        {
          id = "conductor-fixed-target-continuity";
          package = "phenix-conductor";
          test = "fixed_target_continuity";
          label = "conductor / fixed_target_continuity";
        }
        {
          id = "conductor-routed-context-continuity";
          package = "phenix-conductor";
          test = "routed_context_continuity";
          label = "conductor / routed_context_continuity";
        }
        {
          id = "conductor-stdio-roundtrip";
          package = "phenix-conductor";
          test = "stdio_roundtrip";
          label = "conductor / stdio_roundtrip";
        }
        {
          id = "conductor-protocol-e2e";
          package = "phenix-conductor";
          test = "protocol_e2e";
          label = "conductor / protocol_e2e";
        }
        {
          id = "conductor-runtime-edge-cases";
          package = "phenix-conductor";
          test = "runtime_edge_cases";
          label = "conductor / runtime_edge_cases";
        }
      ];

      cargoTestTargets = integrationTargets ++ systemTargets;

      mkCargoTestCommands =
        targets:
        builtins.listToAttrs (
          builtins.map (target: {
            name = target.id;
            value = {
              description = target.label;
              ci = rustCi // {
                stepName = target.label;
              };
              runtimeInputs = pkgs: [
                pkgs.cargo
                pkgs.git
                pkgs.rustc
              ];
              exec = ''
                ${rustRoot}
                cargo test --locked -p ${target.package} --test ${target.test}
              '';
            };
          }) targets
        );

      expectedCargoTargetLines = builtins.concatStringsSep "\n" (
        builtins.map (target: "printf '%s\\t%s\\n' '${target.package}' '${target.test}'") cargoTestTargets
      );

      mkProductCommand =
        {
          check,
          description,
          stepName,
        }:
        {
          inherit description;
          ci = productCi // {
            inherit stepName;
          };
          runtimeInputs = pkgs: [
            pkgs.git
            pkgs.nix
          ];
          exec = ''
            ${repositoryRoot}
            system="$(nix eval --impure --raw --expr builtins.currentSystem)"
            nix build --no-link --print-build-logs ".#checks.$system.${check}"
          '';
        };

      maintenance = maintenanceLib.mkMaintenance {
        name = "maintenance";
        description = "Phenix ACP maintenance";
        ci.github = {
          enable = true;
          outputName = "phenix-maintenance";
        };
        gitHooks = {
          enable = true;
          preCommit = [ "fix" ];
        };

        commands = {
          all = {
            description = "Run the complete read-only validation graph";
            exec = ''
              "$0" check
              "$0" test
            '';
          };

          check = {
            description = "Run static/source validation";
            order = [
              "source"
              "rust"
            ];
            commands = {
              source = {
                description = "Formatting, source analysis, test classification, and workflow consistency";
                order = [
                  "nix-format"
                  "rust-format"
                  "statix"
                  "actionlint"
                  "test-targets"
                  "workflow-sync"
                ];
                commands = {
                  nix-format = {
                    description = "Nix formatting";
                    ci = sourceCi // {
                      stepName = "Nix formatting";
                    };
                    runtimeInputs = pkgs: [
                      pkgs.findutils
                      pkgs.git
                      pkgs.nixfmt
                    ];
                    exec = ''
                      ${repositoryRoot}
                      find . -type f -name '*.nix' \
                        -not -path './.git/*' \
                        -print0 |
                        xargs -0 -r nixfmt --check
                    '';
                  };

                  rust-format = {
                    description = "Rust formatting";
                    ci = sourceCi // {
                      stepName = "Rust formatting";
                    };
                    runtimeInputs = pkgs: [
                      pkgs.cargo
                      pkgs.git
                      pkgs.rustfmt
                    ];
                    exec = ''
                      ${rustRoot}
                      cargo fmt --all --check
                    '';
                  };

                  statix = {
                    description = "Nix static analysis";
                    ci = sourceCi // {
                      stepName = "Statix";
                    };
                    runtimeInputs = pkgs: [
                      pkgs.git
                      pkgs.statix
                    ];
                    exec = ''
                      ${repositoryRoot}
                      statix check --ignore '.git/**'
                    '';
                  };

                  actionlint = {
                    description = "GitHub Actions syntax";
                    ci = sourceCi // {
                      stepName = "Actionlint";
                    };
                    runtimeInputs = pkgs: [
                      pkgs.actionlint
                      pkgs.findutils
                      pkgs.git
                    ];
                    exec = ''
                      ${repositoryRoot}
                      find .github/workflows -type f \
                        \( -name '*.yml' -o -name '*.yaml' \) -print0 |
                        xargs -0 -r actionlint
                    '';
                  };

                  test-targets = {
                    description = "Every Cargo integration target has an explicit test boundary";
                    ci = sourceCi // {
                      stepName = "Test target classification";
                    };
                    runtimeInputs = pkgs: [
                      pkgs.cargo
                      pkgs.coreutils
                      pkgs.diffutils
                      pkgs.git
                      pkgs.jq
                    ];
                    exec = ''
                      ${rustRoot}
                      expected="$(mktemp)"
                      actual="$(mktemp)"
                      trap 'rm -f "$expected" "$actual"' EXIT

                      {
                        ${expectedCargoTargetLines}
                      } | sort > "$expected"

                      cargo metadata --format-version 1 --no-deps |
                        jq -r '
                          .packages[]
                          | . as $package
                          | .targets[]
                          | select(.kind == ["test"])
                          | [$package.name, .name]
                          | @tsv
                        ' |
                        sort > "$actual"

                      diff -u "$expected" "$actual"
                    '';
                  };

                  workflow-sync = {
                    description = "Committed GitHub workflow matches the Nix CI declaration";
                    ci = sourceCi // {
                      stepName = "Generated workflow";
                    };
                    runtimeInputs = pkgs: [
                      pkgs.diffutils
                      pkgs.git
                      pkgs.nix
                    ];
                    exec = ''
                      ${repositoryRoot}
                      system="$(nix eval --impure --raw --expr builtins.currentSystem)"
                      generated="$(mktemp)"
                      trap 'rm -f "$generated"' EXIT
                      nix eval --raw \
                        ".#packages.$system.phenix-maintenance.phenixMaintenance.ci.github.workflow" \
                        > "$generated"
                      diff -u .github/workflows/ci.yml "$generated"
                    '';
                  };
                };
              };

              rust = {
                description = "Rust static analysis with Clippy";
                ci = rustCi // {
                  stepName = "Clippy";
                };
                runtimeInputs = pkgs: [
                  pkgs.cargo
                  pkgs.clippy
                  pkgs.git
                  pkgs.rustc
                ];
                exec = ''
                  ${rustRoot}
                  cargo clippy --workspace --all-targets --locked -- -D warnings
                '';
              };
            };
          };

          test = {
            description = "Run tests by architectural boundary";
            order = [
              "unit"
              "doc"
              "integration"
              "system"
              "product"
            ];
            commands = {
              unit = {
                description = "In-crate library and binary tests";
                ci = rustCi // {
                  stepName = "Unit tests";
                };
                runtimeInputs = pkgs: [
                  pkgs.cargo
                  pkgs.git
                  pkgs.rustc
                ];
                exec = ''
                  ${rustRoot}
                  cargo test --workspace --lib --bins --locked
                '';
              };

              doc = {
                description = "Rust documentation tests";
                ci = rustCi // {
                  stepName = "Doc tests";
                };
                runtimeInputs = pkgs: [
                  pkgs.cargo
                  pkgs.git
                  pkgs.rustc
                ];
                exec = ''
                  ${rustRoot}
                  cargo test --workspace --doc --locked
                '';
              };

              integration = {
                description = "Crate/API integration targets";
                order = builtins.map (target: target.id) integrationTargets;
                commands = mkCargoTestCommands integrationTargets;
              };

              system = {
                description = "Black-box conductor/process/protocol targets";
                order = builtins.map (target: target.id) systemTargets;
                commands = mkCargoTestCommands systemTargets;
              };

              product = {
                description = "Installed ACP behavior and package realization";
                order = [
                  "phenix-acp"
                  "stitch-runtime"
                  "stitch-mcp"
                ];
                commands = {
                  phenix-acp = mkProductCommand {
                    check = "phenix-product-smoke";
                    description = "Run the installed Phenix ACP smoke fixture";
                    stepName = "Phenix ACP smoke";
                  };
                  stitch-runtime = mkProductCommand {
                    check = "stitch-runtime-smoke";
                    description = "Installed Stitch runtime smoke";
                    stepName = "Stitch runtime smoke";
                  };
                  stitch-mcp = mkProductCommand {
                    check = "stitch-mcp-package";
                    description = "Stitch MCP package build";
                    stepName = "Stitch MCP package";
                  };
                };
              };
            };
          };

          fix = {
            description = "Apply deterministic Nix and Rust normalization";
            runtimeInputs = pkgs: [
              pkgs.cargo
              pkgs.findutils
              pkgs.git
              pkgs.nixfmt
              pkgs.rustfmt
              pkgs.statix
            ];
            exec = ''
              ${repositoryRoot}

              statix fix

              find . -type f -name '*.nix' \
                -not -path './.git/*' \
                -print0 |
                xargs -0 -r nixfmt

              (
                cd rust
                cargo fmt --all
              )
            '';
          };
        };
      };

      maintenancePackage = maintenanceLib.mkMaintenancePackage {
        inherit pkgs maintenance;
      };
    in
    {
      packages.phenix-maintenance = maintenancePackage.package;
      apps.phenix-maintenance = maintenancePackage.app;

      devShells.default = pkgs.mkShell {
        name = "phenix-acp-dev";
        packages = [
          pkgs.actionlint
          pkgs.cargo
          pkgs.clippy
          pkgs.git
          pkgs.jq
          pkgs.lua-language-server
          pkgs.nixd
          pkgs.nixfmt
          pkgs.rust-analyzer
          pkgs.rustc
          pkgs.rustfmt
          pkgs.statix
          pkgs.taplo
          maintenancePackage.package
          self'.packages.stitch
          self'.packages.stitch-mcp
        ];
        shellHook = ''
          ${maintenancePackage.shellHook}

          echo "phenix-acp dev shell"
          echo "  all:          maintenance all"
          echo "  static:       maintenance check"
          echo "  tests:        maintenance test"
          echo "  unit:         maintenance test unit"
          echo "  integration:  maintenance test integration"
          echo "  system:       maintenance test system"
          echo "  product:      maintenance test product"
          echo "  fixes:        maintenance fix"
        '';
      };
    };
}