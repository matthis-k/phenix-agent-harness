{ inputs, ... }:

{
  perSystem =
    { system, ... }:
    {
      phenixWrapped = {
        phenix = inputs.self.packages.${system}.phenix;
        conductor = inputs.self.packages.${system}.phenix-conductor;
        runtime = inputs.self.packages.${system}.phenix-conductor;
        stitch = inputs.self.packages.${system}.stitch;
        stitchMcp = inputs.self.packages.${system}.stitch-mcp;
      };
    };
}
