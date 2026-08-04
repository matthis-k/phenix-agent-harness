{ inputs, ... }:

{
  perSystem =
    { system, ... }:
    {
      phenixWrapped = {
        pi = inputs.self.packages.${system}.pi;
        piPackage = inputs.self.packages.${system}.phenix-pi-package;
        rtk = inputs.self.packages.${system}.phenix-rtk;
        stitch = inputs.self.packages.${system}.stitch;
        stitchMcp = inputs.self.packages.${system}.stitch-mcp;
      };
    };
}
