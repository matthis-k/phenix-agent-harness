{ inputs, ... }:

{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:

    let
      tooling = import ./tooling.nix { inherit pkgs; };
      phenixLib = inputs.phenix-pins.lib;
      phenixPiPackage = self'.packages.phenix-pi-package;
      mcpConfig = ./phenix-pi/config/mcp.json;
      piRuntimeInputs = tooling.harnessRuntime ++ [
        self'.packages.phenix-rtk
        pkgs.mcp-nixos
        self'.packages.stitch
        self'.packages.stitch-mcp
      ];
      piRun = ''
        agent_dir="''${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
        mkdir -p "$agent_dir"
        chmod 0700 "$agent_dir" 2>/dev/null || true

        seed_config() {
          local name="$1"
          local source="$PHENIX_SOURCE_ROOT/config/$name"
          local target="$agent_dir/$name"
          if [[ ! -e "$target" && -f "$source" ]]; then
            install -m 0600 "$source" "$target"
          fi
        }

        seed_config lsp.json
        seed_config mcp.json

        export PI_CODING_AGENT_DIR="$agent_dir"
        export PI_SKIP_VERSION_CHECK=1
        export PI_TELEMETRY=0
        export PHENIX_RTK_BIN="${self'.packages.phenix-rtk}/bin/rtk"
        export PHENIX_TOKEN_REDUCTION_BACKEND="''${PHENIX_TOKEN_REDUCTION_BACKEND:-rtk}"
        export HYPA_PI_MODE="''${HYPA_PI_MODE:-replace}"
        export HYPA_PI_ENABLE_MCP_PROXY="''${HYPA_PI_ENABLE_MCP_PROXY:-0}"
        export HYPA_PI_ASK_NON_INTERACTIVE="''${HYPA_PI_ASK_NON_INTERACTIVE:-allow}"

        exec "${self'.packages.pi-coding-agent}/bin/pi" \
          -e "$PHENIX_SOURCE_ROOT" \
          "$@"
      '';
      piStore = phenixLib.mkStoreProgram pkgs {
        name = "pi-store";
        source = phenixPiPackage;
        runtimeInputs = piRuntimeInputs;
        run = piRun;
      };
      piDev = phenixLib.mkDevProgram pkgs {
        name = "pi-dev";
        repository = "phenix-agent-harness";
        sourcePath = "modules/phenix-pi";
        runtimeInputs = piRuntimeInputs;
        run = piRun;
      };
      pi = phenixLib.mkDevWrapper pkgs {
        name = "pi";
        store = piStore;
        dev = piDev;
      };

      localOperationRuntimeSmoke =
        pkgs.runCommand "phenix-local-operation-runtime-smoke"
          {
            nativeBuildInputs = tooling.localOperationRuntime;
          }
          ''
            command -v devenv >/dev/null
            touch "$out"
          '';

      mcpDefaultsSmoke =
        pkgs.runCommand "phenix-mcp-defaults-smoke"
          {
            nativeBuildInputs = [ pkgs.jq ];
          }
          ''
            jq -e '
              .settings.directTools == false and
              .mcpServers.stitch.command == "stitch-mcp" and
              .mcpServers.stitch.lifecycle == "lazy" and
              .mcpServers.nixos.command == "mcp-nixos" and
              .mcpServers.nixos.lifecycle == "lazy" and
              .mcpServers."qt-docs".url == "https://qt-docs-mcp.qt.io/mcp" and
              .mcpServers."qt-docs".lifecycle == "lazy" and
              .mcpServers.context7.url == "https://mcp.context7.com/mcp" and
              .mcpServers.context7.lifecycle == "lazy"
            ' ${mcpConfig}
            test -x ${pkgs.mcp-nixos}/bin/mcp-nixos
            touch "$out"
          '';

      phenixRtkSmoke =
        pkgs.runCommand "phenix-rtk-smoke"
          {
            nativeBuildInputs = [
              self'.packages.phenix-rtk
              pkgs.gitMinimal
            ];
          }
          ''
            rtk --version
            set +e
            rewritten="$(rtk rewrite 'git status')"
            code=$?
            set -e
            test "$code" -eq 0 -o "$code" -eq 3
            test "$rewritten" = "rtk git status"

            mkdir -p "$TMPDIR/config/rtk" "$TMPDIR/repository" "$TMPDIR/tee"
            cat > "$TMPDIR/config/rtk/config.toml" <<'EOF'
            [tee]
            enabled = false
            mode = "never"
            max_files = 1
            max_file_size = 1

            [tracking]
            enabled = false
            history_days = 0

            [telemetry]
            enabled = false
            EOF

            cd "$TMPDIR/repository"
            git init --quiet
            git config user.email phenix@example.invalid
            git config user.name Phenix
            touch tracked.txt
            git add tracked.txt
            git commit --quiet -m initial
            echo changed > tracked.txt

            PHENIX_RTK_LOSSLESS=1 \
              RTK_TEE=0 \
              RTK_TEE_DIR="$TMPDIR/tee" \
              XDG_CONFIG_HOME="$TMPDIR/config" \
              rtk git status > "$TMPDIR/compact-status.txt"

            tee_file="$TMPDIR/tee/phenix-raw.log"
            test -f "$tee_file"
            grep -q tracked.txt "$tee_file"
            touch "$out"
          '';
    in
    {
      packages = {
        default = pi;
        inherit pi;
        pi-store = piStore;
        pi-dev = piDev;
      };

      checks = {
        local-operation-runtime = localOperationRuntimeSmoke;
        mcp-defaults = mcpDefaultsSmoke;
        phenix-rtk = phenixRtkSmoke;
        inherit pi;
        pi-store = piStore;
        pi-dev = piDev;
      };
    };
}
