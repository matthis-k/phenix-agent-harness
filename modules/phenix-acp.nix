_: {
  perSystem =
    { pkgs, ... }:
    let
      rustSource = pkgs.lib.cleanSource ../rust;

      phenixWorkspaceGrep = pkgs.writeShellScript "phenix-workspace-grep" ''
        set -euo pipefail

        ignore_case=()
        while (( "$#" > 0 )); do
          case "$1" in
            --recursive|--line-number|--with-filename|--binary-files=without-match|--exclude-dir=.git)
              shift
              ;;
            --ignore-case)
              ignore_case+=(--ignore-case)
              shift
              ;;
            --)
              shift
              break
              ;;
            *)
              printf 'unsupported grep option: %s\n' "$1" >&2
              exit 2
              ;;
          esac
        done

        if (( "$#" != 2 )); then
          printf 'expected grep pattern and path, got %s arguments\n' "$#" >&2
          exit 2
        fi

        pattern="$1"
        path="$2"
        case "$path" in
          "~")
            candidate="$HOME"
            ;;
          "~/"*)
            candidate="$HOME/''${path#~/}"
            ;;
          /*)
            candidate="$path"
            ;;
          *)
            candidate="$PWD/$path"
            ;;
        esac

        workspace="$(${pkgs.coreutils}/bin/realpath -m -- "$PWD")"
        candidate="$(${pkgs.coreutils}/bin/realpath -m -- "$candidate")"
        case "$candidate" in
          "$workspace"|"$workspace"/*)
            ;;
          *)
            printf 'grep path escapes workspace: %s\n' "$path" >&2
            exit 2
            ;;
        esac
        search_path="$(${pkgs.coreutils}/bin/realpath -m --relative-to="$workspace" -- "$candidate")"

        exec ${pkgs.ripgrep}/bin/rg \
          --hidden \
          --no-ignore \
          --line-number \
          --with-filename \
          --no-heading \
          --color never \
          --glob '!.git/**' \
          --glob '!**/.git/**' \
          "''${ignore_case[@]}" \
          -- "$pattern" "$search_path"
      '';

      phenixConductor = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-conductor";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-conductor"
          "--bin"
          "phenix-conductor"
        ];
        nativeBuildInputs = [
          pkgs.cmake
          pkgs.makeWrapper
        ];
        doCheck = false;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin" "$out/libexec"
          conductor_binary="$(find target -path '*/release/phenix-conductor' -type f -print -quit)"
          test -n "$conductor_binary"
          cp "$conductor_binary" "$out/libexec/phenix-conductor"
          makeWrapper "$out/libexec/phenix-conductor" "$out/bin/phenix-conductor" \
            --set PHENIX_BASH "${pkgs.bash}/bin/bash" \
            --set PHENIX_GREP "${phenixWorkspaceGrep}" \
            --set SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" \
            --set NIX_SSL_CERT_FILE "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
          runHook postInstall
        '';
      };

      phenixAcpSmoke = pkgs.rustPlatform.buildRustPackage {
        pname = "phenix-acp-smoke";
        version = "0";
        src = rustSource;

        cargoLock.lockFile = ../rust/Cargo.lock;
        cargoBuildFlags = [
          "--package"
          "phenix-acp-presets"
          "--bin"
          "phenix-acp-smoke"
        ];
        doCheck = false;

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/bin"
          smoke_binary="$(find target -path '*/release/phenix-acp-smoke' -type f -print -quit)"
          test -n "$smoke_binary"
          cp "$smoke_binary" "$out/bin/phenix-acp-smoke"
          runHook postInstall
        '';
      };

      phenixProductSmoke =
        pkgs.runCommand "phenix-product-smoke"
          {
            nativeBuildInputs = [
              phenixAcpSmoke
              pkgs.gnugrep
              pkgs.jq
            ];
          }
          ''
            phenix-acp-smoke

            grep_home="$TMPDIR/grep-home"
            grep_workspace="$grep_home/phenix/repos/phenix-nvim"
            mkdir -p "$grep_workspace/lua/phenix" "$grep_workspace/.git"
            printf '%s\n' 'transcript input' > "$grep_workspace/lua/phenix/ui.lua"
            printf '%s\n' 'transcript should not escape .git' > "$grep_workspace/.git/secret.txt"
            (
              cd "$grep_workspace"
              HOME="$grep_home" "${phenixWorkspaceGrep}" \
                --recursive \
                --line-number \
                --with-filename \
                --binary-files=without-match \
                --exclude-dir=.git \
                -- \
                'transcript|input' \
                '~/phenix/repos/phenix-nvim'
            ) > "$TMPDIR/grep-output.txt"
            grep -F -- 'lua/phenix/ui.lua:1:transcript input' "$TMPDIR/grep-output.txt" >/dev/null
            if grep -F -- '.git/secret.txt' "$TMPDIR/grep-output.txt" >/dev/null; then
              echo 'workspace grep searched .git unexpectedly' >&2
              exit 1
            fi
            if (
              cd "$grep_workspace"
              HOME="$grep_home" "${phenixWorkspaceGrep}" \
                --recursive \
                --line-number \
                --with-filename \
                --binary-files=without-match \
                --exclude-dir=.git \
                -- \
                transcript \
                '~/outside'
            ) >/dev/null 2>&1; then
              echo 'workspace grep accepted a path outside the workspace' >&2
              exit 1
            fi

            conductor="${phenixConductor}/bin/phenix-conductor"
            "$conductor" --help > "$TMPDIR/conductor-help.txt"
            grep -F -- '--acp-command' "$TMPDIR/conductor-help.txt" >/dev/null

            export PHENIX_CREDENTIAL_FILE="$TMPDIR/credentials.json"
            export PHENIX_MODEL="openai-codex/product-smoke-model"
            response="$TMPDIR/conductor.jsonl"
            {
              printf '%s\n' '{"id":1,"command":{"type":"initialize","after_sequence":null}}'
              printf '%s\n' '{"id":2,"command":{"type":"create_session","parent_session":null,"name":"product smoke","target":{"kind":"fixed","value":{"backend":"phenix","provider":"openai-codex","model":"product-smoke-model","inference":{}}}}}'
              printf '%s\n' '{"id":3,"command":{"type":"get_callable_catalog"}}'
            } | "$conductor" > "$response"

            jq -s -e '
              ([
                .[]
                | select(
                    .type == "response"
                    and .id == 1
                    and .status == "ok"
                    and .result.type == "initialized"
                  )
                | .result.backends[]
                | select(.backend == "phenix")
                | .models[]
                | select(
                    .target.backend == "phenix"
                    and .target.provider == "openai-codex"
                    and .target.model == "product-smoke-model"
                  )
              ] | length == 1)
              and ([
                .[]
                | select(
                    .type == "response"
                    and .id == 2
                    and .status == "ok"
                    and .result.type == "session"
                  )
                | .result.session
                | select(
                    .default_target.kind == "fixed"
                    and .default_target.value.backend == "phenix"
                    and .default_target.value.provider == "openai-codex"
                    and .default_target.value.model == "product-smoke-model"
                    and .default_target.value.inference.effort == null
                  )
              ] | length == 1)
              and ([
                .[]
                | select(
                    .type == "response"
                    and .id == 3
                    and .status == "ok"
                    and .result.type == "callable_catalog"
                  )
                | .result.callables[]
                | select(.kind == "tool" and (.id == "bash" or .id == "grep" or .id == "read" or .id == "write"))
                | .id
              ] | sort == ["bash", "grep", "read", "write"])
            ' "$response" >/dev/null

            touch "$out"
          '';
    in
    {
      packages = {
        phenix-conductor = phenixConductor;
        phenix-acp-smoke = phenixAcpSmoke;
        default = phenixConductor;
      };

      apps = {
        phenix-conductor.program = "${phenixConductor}/bin/phenix-conductor";
        default.program = "${phenixConductor}/bin/phenix-conductor";
      };

      checks.phenix-product-smoke = phenixProductSmoke;
    };
}
