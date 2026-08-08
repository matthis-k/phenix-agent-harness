{ inputs, ... }:

{
  perSystem =
    { system, ... }:
    {
      phenixWrapped = {
        phenix = inputs.self.packages.${system}.phenix;
        conductor = inputs.self.packages.${system}.phenix-conductor;
        piAcp = inputs.self.packages.${system}.pi-acp;
        stitch = inputs.self.packages.${system}.stitch;
        stitchMcp = inputs.self.packages.${system}.stitch-mcp;
      };
    };
}
