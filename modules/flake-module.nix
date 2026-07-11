{ inputs, ... }:

{
  perSystem =
    { system, ... }:
    {
      phenixWrapped = {
        pi = inputs.self.packages.${system}.pi;
        piPackage = inputs.self.packages.${system}.phenix-shell;
      };
    };
}
