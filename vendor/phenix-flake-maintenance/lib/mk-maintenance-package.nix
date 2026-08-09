{
  pkgs,
  maintenance,
}:
let
  inherit (builtins)
    attrNames
    concatLists
    isFunction
    isList
    map
    ;

  fail = message: throw "phenix-flake-maintenance: ${message}";

  collectRuntimeInputs =
    path: node:
    let
      raw = node.runtimeInputs or [ ];
      resolved = if isFunction raw then raw pkgs else raw;
      children = node.commands or { };
      nested = concatLists (
        map (name: collectRuntimeInputs (path ++ [ name ]) children.${name}) (attrNames children)
      );
    in
    if !isList resolved then
      fail "`${
        builtins.concatStringsSep " " ([ maintenance.name ] ++ path)
      }`: runtimeInputs must resolve to a list"
    else
      resolved ++ nested;

  runtimeInputs = concatLists (
    map (name: collectRuntimeInputs [ name ] maintenance.commands.${name}) (
      attrNames maintenance.commands
    )
  );

  basePackage = pkgs.writeShellApplication {
    inherit (maintenance) name;
    inherit runtimeInputs;
    text = maintenance.script;
  };

  package = basePackage.overrideAttrs (old: {
    passthru = (old.passthru or { }) // {
      phenixMaintenance = {
        schemaVersion = maintenance.ci.schemaVersion;
        commandName = maintenance.name;
        inherit (maintenance) ci;
      };
    };
  });
in
{
  inherit package runtimeInputs;

  app = {
    type = "app";
    program = "${package}/bin/${maintenance.name}";
  };
}
