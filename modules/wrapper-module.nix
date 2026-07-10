{
  config,
  wlib,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.pi;

  pathList = paths: lib.concatStringsSep ":" (map toString paths);
  boolEnv = value: if value then "1" else "0";

  piRuntimeRoot =
    if cfg.packageRoot != null then
      cfg.packageRoot
    else
      "${config.package}/lib/node_modules/pi-monorepo";

  # All package paths included in settings.packages:
  #   - pi.configDir (if loadConfigDirAsPackage is set)
  #   - all pi.piPackages entries
  #   - all pi.packageDirs entries
  packagePaths =
    (lib.optional (cfg.configDir != null && cfg.loadConfigDirAsPackage) (toString cfg.configDir))
    ++ (map toString cfg.piPackages)
    ++ (map toString cfg.packageDirs);

  generatedSettings =
    pkgs.writeText "phenix-pi-settings.json" (
      builtins.toJSON (
        cfg.settings
        // {
          theme = cfg.theme;
        }
        // lib.optionalAttrs (packagePaths != [ ]) {
          packages = packagePaths;
        }
        // lib.optionalAttrs (cfg.configDir != null && cfg.directResourceCompat) {
          extensions = [
            "${cfg.configDir}/pi/extensions/lsp.ts"
            "${cfg.configDir}/pi/extensions/phenix-router.ts"
          ];
          prompts = [ "${cfg.configDir}/pi/prompts" ];
          skills = [ "${cfg.configDir}/pi/skills" ];
          themes = [ "${cfg.configDir}/pi/themes" ];
        }
      )
    );
in
{
  imports = [ wlib.modules.default ];

  options.pi = {
    configDir = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Store-backed Phenix Pi config/resource directory.

        Expected layout:
          package.json
          pi/extensions
          pi/prompts
          pi/skills
          pi/themes
      '';
    };

    stateDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Mutable Pi state directory.

        If null, runtime default is:
          ''${XDG_STATE_HOME:-$HOME/.local/state}/phenix-pi
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrs;
      default = {
        defaultProjectTrust = "ask";
        enableInstallTelemetry = false;
        enableAnalytics = false;
        defaultProvider = "phenix";
        defaultModel = "opencode-go";
      };
      description = "Base Pi settings written to managed settings.json.";
    };

    theme = lib.mkOption {
      type = lib.types.str;
      default = "catppuccin-mocha";
      description = "Pi theme name.";
    };

    loadConfigDirAsPackage = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Add pi.configDir to settings.packages.";
    };

    directResourceCompat = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Also add direct extensions/prompts/skills/themes paths derived from pi.configDir.

        Useful for older Pi versions or debugging package discovery.
      '';
    };

    managedConfig = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Copy generated settings.json into PI_CODING_AGENT_DIR.";
    };

    packageRoot = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Optional Pi runtime package root override.

        Defaults to ''${config.package}/lib/node_modules/pi-monorepo.
        Do not point this at cache or at pi.configDir.
      '';
    };

    skipVersionCheck = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Set PI_SKIP_VERSION_CHECK=1.";
    };

    telemetry = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Set PI_TELEMETRY to 1 or 0.";
    };

    offline = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Set PI_OFFLINE=1.";
    };

    sessionDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional Pi session directory.";
    };

    models = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional models.json path. Sets PI_MODELS_PATH.";
    };

    skills = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional skill dirs. Prefer pi.configDir for Phenix resources.";
    };

    extensions = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional extension dirs. Prefer pi.configDir for Phenix resources.";
    };

    themes = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional theme dirs. Prefer pi.configDir for Phenix resources.";
    };

    promptTemplates = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional prompt template dirs. Prefer pi.configDir for Phenix resources.";
    };

    piPackages = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = ''
        Additional Pi package root directories to include in settings.packages.

        Superseded by packageDirs.  Prefer packageDirs for store-backed
        paths so the intent is clearer.
      '';
    };

    packageDirs = lib.mkOption {
      type = lib.types.listOf (lib.types.either lib.types.path lib.types.str);
      default = [ ];
      description = ''
        Additional Pi package root directories to add to settings.packages.

        Use this for store-backed package directories, pointing to
        third-party pi packages inside a Nix-built node_modules tree.
        This avoids relying on mutable global `pi install` state.
      '';
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Extra tools available on PATH inside wrapped Pi.";
    };

    extraEnv = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Extra environment variables to set in the wrapper.";
    };

    extraFlags = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Extra CLI flags passed to Pi.";
    };
  };

  config = {
    wrapperImplementation = "shell";

    env =
      {
        PI_PACKAGE_DIR = toString piRuntimeRoot;
        PI_SKIP_VERSION_CHECK = boolEnv cfg.skipVersionCheck;
        PI_TELEMETRY = boolEnv cfg.telemetry;
      }
      // lib.optionalAttrs cfg.offline {
        PI_OFFLINE = "1";
      }
      // lib.optionalAttrs (cfg.sessionDir != null) {
        PI_CODING_AGENT_SESSION_DIR = cfg.sessionDir;
      }
      // lib.optionalAttrs (cfg.models != null) {
        PI_MODELS_PATH = toString cfg.models;
      }
      // lib.optionalAttrs (cfg.skills != [ ]) {
        PI_SKILLS_PATHS = pathList cfg.skills;
      }
      // lib.optionalAttrs (cfg.extensions != [ ]) {
        PI_EXTENSIONS_PATHS = pathList cfg.extensions;
      }
      // lib.optionalAttrs (cfg.themes != [ ]) {
        PI_THEMES_PATHS = pathList cfg.themes;
      }
      // lib.optionalAttrs (cfg.promptTemplates != [ ]) {
        PI_PROMPT_TEMPLATES_PATHS = pathList cfg.promptTemplates;
      }
      // cfg.extraEnv;

    runtimePkgs =
      [
        pkgs.git
        pkgs.ripgrep
        pkgs.fd
        pkgs.gnutar
        pkgs.unzip
      ]
      ++ cfg.extraPackages;

    flags = lib.listToAttrs (
      map (
        flag:
        let
          parts = lib.splitString "=" flag;
        in
        if builtins.length parts == 1 then
          {
            name = flag;
            value = true;
          }
        else
          {
            name = builtins.head parts;
            value = lib.concatStringsSep "=" (builtins.tail parts);
          }
      ) cfg.extraFlags
    );

    runShell = [
      ''
        if [ -z "''${PI_CODING_AGENT_DIR:-}" ]; then
          ${
            if cfg.stateDir == null then
              ''PI_CODING_AGENT_DIR="''${XDG_STATE_HOME:-$HOME/.local/state}/phenix-pi"''
            else
              ''PI_CODING_AGENT_DIR=${lib.escapeShellArg cfg.stateDir}''
          }
        fi

        case "$PI_CODING_AGENT_DIR" in
          "~")
            PI_CODING_AGENT_DIR="$HOME"
            ;;
          "~/"*)
            PI_CODING_AGENT_DIR="$HOME/''${PI_CODING_AGENT_DIR#"~/"}"
            ;;
        esac

        export PI_CODING_AGENT_DIR

        mkdir -p "$PI_CODING_AGENT_DIR"

        if [ "${boolEnv cfg.managedConfig}" = "1" ] && [ "''${PHENIX_PI_MANAGED_CONFIG:-1}" = "1" ]; then
          if [ ! -e "$PI_CODING_AGENT_DIR/settings.json" ] || ! cmp -s ${generatedSettings} "$PI_CODING_AGENT_DIR/settings.json"; then
            install -m 0644 ${generatedSettings} "$PI_CODING_AGENT_DIR/settings.json"
          fi
        fi
      ''
    ];
  };
}
