let
  ciSchemaVersion = 1;
  renderMaintenance = import ./render-maintenance.nix;
  mkMaintenance = import ./mk-maintenance.nix {
    inherit ciSchemaVersion renderMaintenance;
  };
  mkMaintenancePackage = import ./mk-maintenance-package.nix;

  mkMaintenanceOutputs =
    {
      maintenance,
      systems,
      pkgsFor,
      outputName ? "phenix-maintenance",
    }:
    let
      materialized = system: mkMaintenancePackage {
        pkgs = pkgsFor system;
        inherit maintenance;
      };

      perSystem = selector:
        builtins.listToAttrs (
          builtins.map
            (system: {
              name = system;
              value = {
                ${outputName} = selector (materialized system);
              };
            })
            systems
        );
    in
    {
      packages = perSystem (value: value.package);
      apps = perSystem (value: value.app);
    };
in
{
  version = "0.4.0";
  inherit
    ciSchemaVersion
    mkMaintenance
    mkMaintenanceOutputs
    mkMaintenancePackage
    renderMaintenance
    ;
}
