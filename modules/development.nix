_: {
  perSystem =
    {
      pkgs,
      self',
      ...
    }:
    let
      maintenanceLib = import ../vendor/phenix-flake-maintenance/lib;

      repositoryRoot = ''
        repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
        cd "$repo_root"
      '';
      rustRoot = ''
        ${repositoryRoot}
        cd rust
      '';

      rustCi = {
        enable = true;
        stage = "rust";
        name = "Rust";
        timeoutMinutes = 60;
      };

      maintenance = maintenanceLib.mkMaintenance {
        name = "maintenance";
        description = "Phenix agent harness maintenance";

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
                description = "Formatting, Nix analysis, workflow syntax, and flake evaluation";
                ci = {
                  enable = true;
                  stage = "source";
                  name = "Source";
                  timeoutMinutes = 20;
                };
                runtimeInputs = pkgs: [
                  pkgs.actionlint
                  pkgs.cargo
                  pkgs.findutils
                  pkgs.git
                  pkgs.nix
                  pkgs.nixfmt
                  pkgs.rustfmt
                  pkgs.statix
                ];
                exec = ''
                  ${repositoryRoot}

                  find . -type f -name '*.nix' \
                    -not -path './.git/*' \
                    -print0 |
                    xargs -0 -r nixfmt --check

                  (
                    cd rust
                    cargo fmt --all --check
                  )

                  statix check --ignore '.git/**'

                  find .github/workflows -type f \( -name '*.yml' -o -name '*.yaml' \) -print0 |
                    xargs -0 -r actionlint

                  nix flake check --no-build --print-build-logs
                '';
              };

              rust = {
                description = "Rust static analysis with Clippy";
                ci = rustCi;
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
              "integration"
              "system"
              "product"
            ];
            commands = {
              unit = {
                description = "In-crate library/binary tests and Rust doc tests";
                ci = rustCi;
                runtimeInputs = pkgs: [
                  pkgs.cargo
                  pkgs.git
                  pkgs.rustc
                ];
                exec = ''
                  ${rustRoot}
                  cargo test --workspace --lib --bins --locked
                  cargo test --workspace --doc --locked
                '';
              };

              integration = {
                description = "Cargo integration targets excluding black-box system tests";
                ci = rustCi;
                runtimeInputs = pkgs: [
                  pkgs.cargo
                  pkgs.git
                  pkgs.jq
                  pkgs.rustc
                ];
                exec = ''
                  ${rustRoot}

                  mapfile -t integration_targets < <(
                    cargo metadata --format-version 1 --no-deps |
                      jq -r '
                        .packages[]
                        | . as $package
                        | .targets[]
                        | select(.kind == ["test"])
                        | select(
                            ($package.name != "phenix-conductor")
                            or (.name != "black_box_model_tool_loop" and .name != "stdio_roundtrip")
                          )
                        | [$package.name, .name]
                        | @tsv
                      '
                  )

                  for target in "''${integration_targets[@]}"; do
                    IFS=$'\t' read -r package test_name <<< "$target"
                    cargo test --locked -p "$package" --test "$test_name"
                  done
                '';
              };

              system = {
                description = "Black-box conductor/process/protocol tests";
                ci = rustCi;
                runtimeInputs = pkgs: [
                  pkgs.cargo
                  pkgs.git
                  pkgs.rustc
                ];
                exec = ''
                  ${rustRoot}
                  cargo test --locked \
                    -p phenix-conductor \
                    --test black_box_model_tool_loop \
                    --test stdio_roundtrip
                '';
              };

              product = {
                description = "Nix-installed product/package smoke checks";
                ci = {
                  enable = true;
                  stage = "product";
                  name = "Product";
                  timeoutMinutes = 60;
                };
                runtimeInputs = pkgs: [
                  pkgs.git
                  pkgs.nix
                ];
                exec = ''
                  ${repositoryRoot}
                  system="$(nix eval --impure --raw --expr builtins.currentSystem)"

                  nix build --no-link --print-build-logs \
                    ".#checks.$system.phenix-product-smoke" \
                    ".#checks.$system.stitch-runtime-smoke" \
                    ".#checks.$system.stitch-mcp-package"
                '';
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
        name = "phenix-agent-harness-dev";
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
          if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            git config core.hooksPath .githooks
          fi

          echo "phenix-agent-harness dev shell"
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
