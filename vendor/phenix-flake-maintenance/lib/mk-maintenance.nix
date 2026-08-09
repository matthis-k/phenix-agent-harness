{ ciSchemaVersion, renderMaintenance }:
{
  name ? "maintenance",
  description ? "Repository maintenance commands",
  commands,
}:
let
  rendered = renderMaintenance {
    inherit name description commands;
  };
in
{
  inherit name description commands;
  script = rendered.script;
  ci = {
    schemaVersion = ciSchemaVersion;
    stageCount = builtins.length rendered.steps;
    inherit (rendered) matrix steps;
  };
}
