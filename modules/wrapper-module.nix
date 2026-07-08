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

  piPackageRoot =
    if cfg.packageRoot != null then
      cfg.packageRoot
    else
      "${config.package}/lib/node_modules/pi-monorepo";
in
{
  imports = [ wlib.modules.default ];

  options.pi = {
    codingAgentDir = lib.mkOption {
      type = lib.types.str;
      default = "~/.config/phenix-pi";
      description = ''
        Mutable Pi config/state directory.

        The wrapper may install a managed settings.json here, but this does
        not replace Pi's runtime/package root.
      '';
    };

    sessionDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Optional Pi session directory.
        Sets PI_CODING_AGENT_SESSION_DIR when non-null.
      '';
    };

    managedSettings = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Store path to a managed settings.json copied into PI_CODING_AGENT_DIR.

        The wrapper copies this file unless PHENIX_PI_MANAGED_CONFIG=0.
      '';
    };

    managedConfig = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether the wrapper should copy managedSettings to settings.json.
      '';
    };

    packageRoot = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Optional Pi runtime package root override.

        Defaults to `${config.package}/lib/node_modules/pi-monorepo`.
        Do not point this at ~/.cache or at the Phenix Pi resource package.
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

    models = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional models.json path. Sets PI_MODELS_PATH.";
    };

    skills = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional skill directories. Sets PI_SKILLS_PATHS.";
    };

    extensions = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional extension directories. Sets PI_EXTENSIONS_PATHS.";
    };

    themes = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional theme directories. Sets PI_THEMES_PATHS.";
    };

    promptTemplates = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = "Additional prompt template directories. Sets PI_PROMPT_TEMPLATES_PATHS.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Extra tools available on PATH inside the wrapped Pi.";
    };

    extraFlags = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Extra CLI flags passed to Pi.";
    };
  };

  config = {
    wrapperImplementation = "binary";

    env = {
      PI_PACKAGE_DIR = toString piPackageRoot;
      PI_CODING_AGENT_DIR = cfg.codingAgentDir;
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
    };

    runtimePkgs = [
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

    runShell = lib.optional (cfg.managedSettings != null) ''
      mkdir -p "$PI_CODING_AGENT_DIR"

      if [ "${boolEnv cfg.managedConfig}" = "1" ] && [ "''${PHENIX_PI_MANAGED_CONFIG:-1}" = "1" ]; then
        if [ ! -e "$PI_CODING_AGENT_DIR/settings.json" ] || ! cmp -s ${cfg.managedSettings} "$PI_CODING_AGENT_DIR/settings.json"; then
          install -m 0644 ${cfg.managedSettings} "$PI_CODING_AGENT_DIR/settings.json"
        fi
      fi
    '';
  };
}
