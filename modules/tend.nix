{ inputs, lib, ... }:

{
  perSystem =
    {
      pkgs,
      self',
      system,
      ...
    }:
    let
      tooling = import ./tooling.nix { inherit pkgs; };
      tendCli = inputs.phenix-tend.packages.${system}.tend-unwrapped;
      phenixPiPackage = self'.packages.phenix-pi-package;
      source = lib.cleanSource ../.;

      phenixCheckFiles = pkgs.writeShellApplication {
        name = "phenix-check-files";
        runtimeInputs = tooling.quality;
        text = ''
          files=("$@")
          if (( ''${#files[@]} == 0 )); then
            exit 0
          fi

          biome_files=()
          nix_files=()
          workflow_files=()

          for file in "''${files[@]}"; do
            [[ -f "$file" ]] || continue

            case "$file" in
              *.js | *.jsx | *.mjs | *.cjs | *.ts | *.tsx | *.mts | *.cts | *.json | *.jsonc)
                biome_files+=("$file")
                ;;
            esac

            case "$file" in
              *.nix)
                nix_files+=("$file")
                ;;
            esac

            case "$file" in
              .github/workflows/*.yml | .github/workflows/*.yaml)
                workflow_files+=("$file")
                ;;
            esac
          done

          status=0

          if (( ''${#biome_files[@]} > 0 )); then
            biome ci \
              --config-path biome.json \
              --no-errors-on-unmatched \
              --files-ignore-unknown=true \
              --error-on-warnings \
              "''${biome_files[@]}" || status=1
          fi

          if (( ''${#nix_files[@]} > 0 )); then
            nixfmt --check "''${nix_files[@]}" || status=1
            for file in "''${nix_files[@]}"; do
              statix check "$file" || status=1
            done
          fi

          for file in "''${workflow_files[@]}"; do
            actionlint "$file" || status=1
          done

          exit "$status"
        '';
      };

      phenixCheckRepository = pkgs.writeShellApplication {
        name = "phenix-check-repository";
        runtimeInputs = tooling.quality ++ [ pkgs.findutils ];
        text = ''
          repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
          cd "$repo_root"

          mapfile -d $'\0' nix_files < <(
            find . \
              -path './.git' -prune -o \
              -path './result' -prune -o \
              -path '*/node_modules' -prune -o \
              -name '*.nix' -type f -print0 |
              sort -z
          )

          if (( ''${#nix_files[@]} > 0 )); then
            nixfmt --check "''${nix_files[@]}"
          fi

          statix check
          actionlint .github/workflows/*.yml
          biome ci \
            --config-path biome.json \
            --no-errors-on-unmatched \
            --files-ignore-unknown=true \
            biome.json \
            .tend.json
        '';
      };

      phenixCheckRuntime = pkgs.writeShellApplication {
        name = "phenix-check-runtime";
        runtimeInputs = [
          pkgs.git
          pkgs.nodejs
          pkgs.typescript
        ];
        text = ''
          repo_root="$(git rev-parse --show-toplevel)"
          mode="''${1:-}"
          pi_root="''${PHENIX_PI_ROOT:-$repo_root/modules/phenix-pi}"

          if [[ ! -d "$pi_root" ]]; then
            printf 'Phenix Pi root does not exist: %s\n' "$pi_root" >&2
            exit 1
          fi

          if [[ ! -d "$pi_root/node_modules" ]]; then
            printf 'Phenix Pi dependencies are missing at %s/node_modules\n' "$pi_root" >&2
            printf 'Run this command through the Nix development shell.\n' >&2
            exit 1
          fi

          case "$mode" in
            runtime-tests)
              cd "$pi_root"
              node --experimental-strip-types --test tests/*.test.ts
              node --check runtime/verify.mjs
              ;;
            typecheck)
              exec tsc --project "$pi_root/tsconfig.json" --pretty false
              ;;
            *)
              printf 'usage: phenix-check-runtime [runtime-tests|typecheck]\n' >&2
              exit 2
              ;;
          esac
        '';
      };

      phenixFormatFiles = pkgs.writeShellApplication {
        name = "phenix-format-files";
        runtimeInputs = tooling.quality;
        text = ''
          files=("$@")
          if (( ''${#files[@]} == 0 )); then
            exit 0
          fi

          biome_files=()
          nix_files=()

          for file in "''${files[@]}"; do
            [[ -f "$file" ]] || continue

            case "$file" in
              *.js | *.jsx | *.mjs | *.cjs | *.ts | *.tsx | *.mts | *.cts | *.json | *.jsonc)
                biome_files+=("$file")
                ;;
            esac

            case "$file" in
              *.nix)
                nix_files+=("$file")
                ;;
            esac
          done

          if (( ''${#biome_files[@]} > 0 )); then
            biome check \
              --write \
              --no-errors-on-unmatched \
              --files-ignore-unknown=true \
              "''${biome_files[@]}"
          fi

          for file in "''${nix_files[@]}"; do
            statix fix "$file"
            nixfmt "$file"
          done
        '';
      };

      phenixTend = pkgs.writeShellApplication {
        name = "tend";
        runtimeInputs = tooling.tendRuntime;
        text = ''
          if repo_root=$(git rev-parse --show-toplevel 2>/dev/null); then
            root="$repo_root"
          else
            root="$PWD"
          fi

          exec ${tendCli}/bin/tend --root "$root" "$@"
        '';
      };

      tendFix = pkgs.writeShellApplication {
        name = "tend-fix";
        runtimeInputs = [
          phenixTend
          pkgs.git
        ];
        text = ''
          repo_root="$(git rev-parse --show-toplevel)"
          cd "$repo_root"

          mapfile -d $'\0' staged_files < <(
            git diff --cached --name-only --diff-filter=ACMR -z
          )

          partially_staged=()
          for file in "''${staged_files[@]}"; do
            [[ -e "$file" ]] || continue
            if ! git diff --quiet -- "$file"; then
              partially_staged+=("$file")
            fi
          done

          if (( ''${#partially_staged[@]} > 0 )); then
            printf '%s\n' \
              'Cannot apply staged repairs to partially staged files.' \
              'Stage or stash their remaining changes first:' >&2
            printf '  %s\n' "''${partially_staged[@]}" >&2
            exit 1
          fi

          tend check --profile fix --context local

          if (( ''${#staged_files[@]} > 0 )); then
            git add -- "''${staged_files[@]}"
          fi

          exec tend check --profile git-hook --context local
        '';
      };

      tendVerify = pkgs.writeShellApplication {
        name = "tend-verify";
        runtimeInputs = [ phenixTend ];
        text = ''
          exec tend check --profile manual --context local "$@"
        '';
      };

      tendPrePush = pkgs.writeShellApplication {
        name = "tend-pre-push";
        runtimeInputs = [ phenixTend ];
        text = ''
          exec tend check --profile pre-push --context local "$@"
        '';
      };

      updatePiNpmLock = pkgs.writeShellApplication {
        name = "update-pi-npm-lock";
        runtimeInputs = [ pkgs.nodejs ];
        text = ''
          if [[ ! -f modules/pi-npm/package.json ]]; then
            echo "run this command from the phenix-agent-harness repository root" >&2
            exit 1
          fi

          npm install \
            --prefix modules/pi-npm \
            --package-lock-only \
            --ignore-scripts \
            --legacy-peer-deps \
            --no-audit \
            --no-fund

          echo "Updated modules/pi-npm/package-lock.json"
        '';
      };

      lifecycleCommands = [
        phenixCheckFiles
        phenixCheckRepository
        phenixCheckRuntime
        phenixFormatFiles
      ];

      gitHooks = pkgs.runCommand "phenix-agent-harness-git-hooks" { } ''
        mkdir -p "$out"

        cat > "$out/pre-commit" <<'EOF'
        #!/usr/bin/env bash
        set -euo pipefail
        repo_root="$(${pkgs.git}/bin/git rev-parse --show-toplevel)"
        exec ${pkgs.nix}/bin/nix develop "$repo_root" --command tend-fix
        EOF

        cat > "$out/pre-push" <<'EOF'
        #!/usr/bin/env bash
        set -euo pipefail
        repo_root="$(${pkgs.git}/bin/git rev-parse --show-toplevel)"
        exec ${pkgs.nix}/bin/nix develop "$repo_root" --command tend-pre-push
        EOF

        chmod +x "$out/pre-commit" "$out/pre-push"
      '';

      tendNixCheck =
        pkgs.runCommand "phenix-tend-nix-check"
          {
            nativeBuildInputs = [
              phenixTend
              pkgs.git
            ]
            ++ lifecycleCommands
            ++ tooling.quality;
            inherit source;
          }
          ''
            cp -rT "$source" source
            chmod -R u+w source

            rm -rf source/modules/phenix-pi/node_modules
            ln -s ${phenixPiPackage}/node_modules source/modules/phenix-pi/node_modules

            cd source
            git init --quiet
            git add -A

            export HOME="$TMPDIR/home"
            export PHENIX_PI_ROOT="$PWD/modules/phenix-pi"
            mkdir -p "$HOME"

            tend check --profile full --context nix-sandbox

            touch "$out"
          '';
    in
    {
      packages.tend = phenixTend;

      apps.tend = {
        type = "app";
        program = "${phenixTend}/bin/tend";
      };

      checks.tend-nix-check = tendNixCheck;

      devShells.default = pkgs.mkShell {
        name = "phenix-agent-harness-dev";
        packages =
          tooling.agentRuntime
          ++ tooling.quality
          ++ lifecycleCommands
          ++ [
            phenixTend
            tendFix
            tendVerify
            tendPrePush
            updatePiNpmLock
            self'.packages.stitch
            self'.packages.stitch-mcp
          ];

        shellHook = ''
          if repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
            git -C "$repo_root" config --local core.hooksPath ${gitHooks}
            hooks_status="enabled"
          else
            hooks_status="not in a Git repository"
          fi

          echo "phenix-agent-harness dev shell"
          echo "  hooks:   $hooks_status"
          echo "  fix:     tend-fix"
          echo "  verify:  tend-verify"
          echo "  prepush: tend-pre-push"
          echo "  npm lock: update-pi-npm-lock"
          echo "  stitch:  stitch workspace discover --json"
        '';
      };
    };
}
