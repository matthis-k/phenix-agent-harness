{ inputs, ... }: {
  perSystem = { system, ... }: {
    phenixWrapped.pi = inputs.self.packages.${system}.default;
  };
}
