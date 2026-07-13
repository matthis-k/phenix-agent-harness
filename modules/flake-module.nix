{ inputs, ... }:

{
  perSystem =
    { system, ... }:
    {
      phenixWrapped = {
        pi = inputs.self.packages.${system}.pi;
        piPackage = inputs.self.packages.${system}.phenix-pi-package;
        tend = inputs.self.packages.${system}.tend;
        stitch = inputs.self.packages.${system}.stitch;
        stitchMcp = inputs.self.packages.${system}.stitch-mcp;
      };
    };
}
