{ lib, ... }:
let
  maintenanceModules = builtins.filter (path: builtins.baseNameOf path == "maintenance.nix") (
    lib.filesystem.listFilesRecursive ./.
  );
in
{
  imports = maintenanceModules;

  enterShell = ''
    if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      git config core.hooksPath .githooks
    fi
  '';

  enterTest = "";
}
